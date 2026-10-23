import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CredentialResolver } from '../../lib/credentials/resolver.js';
import * as db from '../../lib/db.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

class TestSessionCmd extends BaseSessionCommand {
  public async run(): Promise<void> {}

  public loginOverride?: (
    env: eb.Environment,
    headless: boolean,
    username?: string,
    password?: string,
    account?: string,
  ) => Promise<any[]>;

  protected override async performLogin(
    env: eb.Environment,
    headless: boolean,
    username?: string,
    password?: string,
    account?: string,
  ): Promise<any[]> {
    if (this.loginOverride) {
      return await this.loginOverride(env, headless, username, password, account);
    }
    return await super.performLogin(env, headless, username, password, account);
  }

  public async testGetCookies(id: number, headless = true) {
    return await this.getSessionCookies(id, headless);
  }

  public override error(input: string | Error): never {
    const msg = typeof input === 'string' ? input : input.message;
    throw new Error(`CLI Error: ${msg}`);
  }
}

describe('Credential Resolver & Autonomous Re-auth (src/lib/credentials/)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cred-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);

    originalEnv = { ...process.env };
    originalGetBrowser = eb.BrowserManager.getInstance().getBrowser;
    originalCloseBrowser = eb.BrowserManager.getInstance().closeBrowser;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  after(() => {
    eb.BrowserManager.getInstance().getBrowser = originalGetBrowser;
    eb.BrowserManager.getInstance().closeBrowser = originalCloseBrowser;
    db.closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('checks provider availability', () => {
    assert.strictEqual(CredentialResolver.isProviderAvailable('env'), true);
    // Unknown or invalid
    assert.strictEqual(CredentialResolver.isProviderAvailable('nonexistent' as any), false);
  });

  it('resolves credentials from environment variables without leaking secrets', async () => {
    process.env['EB_USERNAME'] = 'env_user@example.com';
    process.env['EB_PASSWORD'] = 'superSecretPass123!';
    process.env['EB_TOTP'] = '654321';
    process.env['EB_ACCOUNT'] = 'Env Account';
    process.env['EB_ENVIRONMENT'] = 'us1';

    const creds = await CredentialResolver.resolve({ provider: 'env', itemRef: 'ignored' });
    assert.strictEqual(creds.username, 'env_user@example.com');
    assert.strictEqual(creds.password, 'superSecretPass123!');
    assert.strictEqual(creds.totp, '654321');
    assert.strictEqual(creds.account, 'Env Account');
    assert.strictEqual(creds.environment, 'us1');

    const totp = await CredentialResolver.getLiveTotp({ provider: 'env', itemRef: 'ignored' });
    assert.strictEqual(totp, '654321');
  });

  it('stores and retrieves credential references in SQLite without storing passwords', () => {
    db.addSession('test@example.com', 'us1', 'Acct1', '[]');
    db.setCredentialRef(1, '1password', 'e-Builder Prod', 'Engineering');

    const ref = db.getCredentialRef(1);
    assert.ok(ref);
    assert.strictEqual(ref.session_id, 1);
    assert.strictEqual(ref.provider, '1password');
    assert.strictEqual(ref.item_ref, 'e-Builder Prod');
    assert.strictEqual(ref.vault, 'Engineering');
    // Ensure no password column exists in credential_refs
    assert.strictEqual((ref as any).password, undefined);

    db.deleteCredentialRef(1);
    assert.strictEqual(db.getCredentialRef(1), undefined);
  });

  it('autonomously re-authenticates via CredentialResolver when session cookies expire', async () => {
    process.env['EB_USERNAME'] = 'auto@example.com';
    process.env['EB_PASSWORD'] = 'autoPass!';
    process.env['EB_ENVIRONMENT'] = 'us1';
    process.env['EB_ACCOUNT'] = 'AutoAcct';

    db.addSession('auto@example.com', 'us1', 'AutoAcct', '[]');
    db.setCredentialRef(1, 'env', 'EB_VARS');

    let loginCalled = false;
    const cmd = new TestSessionCmd([], {} as any);
    cmd.loginOverride = async (
      _env: any,
      _headless: boolean,
      username?: string,
      password?: string,
      account?: string,
    ) => {
      loginCalled = true;
      assert.strictEqual(username, 'auto@example.com');
      assert.strictEqual(password, 'autoPass!');
      assert.strictEqual(account, 'AutoAcct');
      return [{ name: 'fresh_cookie', value: 'auto_token_999' }];
    };

    const mockBrowser: any = {
      connected: true,
      createBrowserContext: async () => ({
        newPage: async () => ({
          setDefaultNavigationTimeout: () => {},
          setDefaultTimeout: () => {},
          goto: async () => {
            throw new Error('Logged out');
          },
          waitForSelector: async () => {
            throw new Error('Not logged in');
          },
          close: async () => {},
        }),
        setCookie: async () => {},
        cookies: async () => [],
        close: async () => {},
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const cookies = await cmd.testGetCookies(1, true);

    assert.ok(cookies);
    assert.strictEqual(cookies[0]?.name, 'fresh_cookie');
    assert.strictEqual(cookies[0]?.value, 'auto_token_999');
    assert.strictEqual(loginCalled, true);

    // Verify cookies updated in database
    const updated = db.getSessionById(1);
    assert.ok(updated?.session_cookies.includes('auto_token_999'));
  });
});
