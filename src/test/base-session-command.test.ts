import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseSessionCommand } from '../lib/base-session-command.js';
import * as db from '../lib/db.js';
import * as eb from '../lib/eb-puppetmaster/index.js';

class ConcreteTestSessionCommand extends BaseSessionCommand {
  public async run(): Promise<void> {}

  public async publicGetSession(flags: {
    'session-id'?: number | undefined;
    username?: string | undefined;
    'show-browser'?: boolean | undefined;
  }) {
    return await this.getSession(flags);
  }

  public async publicGetSessionCookies(sessionId: number, headless: boolean = true) {
    return await this.getSessionCookies(sessionId, headless);
  }

  public async publicRefreshSessionCookies(sessionId: number, headless: boolean = true) {
    return await this.refreshSessionCookies(sessionId, headless);
  }

  public override error(input: string | Error): never {
    const msg = typeof input === 'string' ? input : input.message;
    throw new Error(`CLI Error: ${msg}`);
  }

  public override log(_message?: string): void {}
}

describe('BaseSessionCommand (src/lib/base-session-command.ts)', () => {
  let tmpDir: string;
  let cmd: ConcreteTestSessionCommand;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-base-cmd-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
    cmd = new ConcreteTestSessionCommand([], {} as any);
    originalGetBrowser = eb.BrowserManager.getInstance().getBrowser;
    originalCloseBrowser = eb.BrowserManager.getInstance().closeBrowser;
  });

  after(() => {
    eb.BrowserManager.getInstance().getBrowser = originalGetBrowser;
    eb.BrowserManager.getInstance().closeBrowser = originalCloseBrowser;
    db.closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('getSession with --session-id', () => {
    it('returns the session when valid ID is provided', async () => {
      db.addSession(
        'test@example.com',
        'us1',
        'Acct1',
        JSON.stringify([{ name: 'sid', value: '123' }]),
      );

      const session = await cmd.publicGetSession({ 'session-id': 1 });
      assert.ok(session);
      assert.strictEqual(session.id, 1);
      assert.strictEqual(session.username, 'test@example.com');
    });

    it('throws when session ID is not found', async () => {
      await assert.rejects(
        async () => cmd.publicGetSession({ 'session-id': 999 }),
        /CLI Error: Session with ID 999 not found./,
      );
    });
  });

  describe('getSession with --username', () => {
    it('returns the single matching session for a username', async () => {
      db.addSession('single@example.com', 'us2', 'Acct2', '[]');

      const session = await cmd.publicGetSession({ username: 'single@example.com' });
      assert.ok(session);
      assert.strictEqual(session.username, 'single@example.com');
      assert.strictEqual(session.environment, 'us2');
    });

    it('throws when no session found for username', async () => {
      await assert.rejects(
        async () => cmd.publicGetSession({ username: 'missing@example.com' }),
        /CLI Error: No sessions found for username missing@example.com./,
      );
    });
  });

  describe('getSession default resolution', () => {
    it('returns the single session when exactly one session exists', async () => {
      db.addSession('onlyone@example.com', 'us3', 'Acct3', '[]');

      const session = await cmd.publicGetSession({});
      assert.ok(session);
      assert.strictEqual(session.username, 'onlyone@example.com');
    });

    it('auto-selects the latest session non-interactively when multiple sessions exist', async () => {
      db.addSession('first@example.com', 'us1', 'Acct1', '[]');
      db.addSession('second@example.com', 'us2', 'Acct2', '[]');

      const session = await cmd.publicGetSession({});
      assert.ok(session);
      assert.strictEqual(session.username, 'second@example.com');
      assert.strictEqual(session.id, 2);
    });

    it('throws helpful error non-interactively when no sessions exist', async () => {
      await assert.rejects(
        async () => cmd.publicGetSession({}),
        /CLI Error: No active e-Builder sessions found. Please authenticate first using 'eb session import' or 'eb login'./,
      );
    });
  });

  describe('getSessionCookies and refreshSessionCookies', () => {
    it('returns parsed cookies when refresh succeeds', async () => {
      const originalCookies = [{ name: 'test_cookie', value: 'token123' }];
      db.addSession('user@example.com', 'us1', 'Acct', JSON.stringify(originalCookies));

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForSelector: async (selector: string) => {
              if (selector.includes('tabHomeLink')) return {};
              throw new Error('Not found');
            },
          }),
          setCookie: async () => {},
          cookies: async () => originalCookies,
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const cookies = await cmd.publicGetSessionCookies(1, true);
      assert.deepStrictEqual(cookies, originalCookies);

      const refreshed = await cmd.publicRefreshSessionCookies(1, true);
      assert.deepStrictEqual(refreshed, originalCookies);
    });

    const mockBrowser = (landedUrl: string, gotoError?: Error): any => ({
      connected: true,
      createBrowserContext: async () => ({
        newPage: async () => ({
          setDefaultNavigationTimeout: () => {},
          setDefaultTimeout: () => {},
          url: () => landedUrl,
          goto: async () => {
            if (gotoError) throw gotoError;
          },
          waitForSelector: async () => {
            throw new Error('Timeout');
          },
        }),
        setCookie: async () => {},
        cookies: async () => [],
        close: async () => {},
      }),
    });

    it('throws when session has expired and cannot be refreshed', async () => {
      db.addSession('expired@example.com', 'us1', 'Acct', '[]');
      eb.BrowserManager.getInstance().getBrowser = async () =>
        mockBrowser('https://app.e-builder.net/Login/Login.aspx');

      await assert.rejects(
        async () => cmd.publicGetSessionCookies(1, true),
        /Session has expired.*Please log in again using 'eb login'/,
      );
    });

    it('reports a network error (not expiry) when e-Builder is unreachable', async () => {
      db.addSession('offline@example.com', 'us1', 'Acct', '[]');
      eb.BrowserManager.getInstance().getBrowser = async () =>
        mockBrowser('about:blank', new Error('net::ERR_NAME_NOT_RESOLVED'));

      await assert.rejects(
        async () => cmd.publicGetSessionCookies(1, true),
        (err: any) => {
          assert.match(err.message, /Cannot reach https:\/\/app\.e-builder\.net/);
          assert.match(err.message, /NOT invalidated/);
          assert.doesNotMatch(err.message, /Session has expired/);
          return true;
        },
      );
      assert.strictEqual(db.getSessions().length, 1);
    });

    it('returns stored cookies without a browser when skipRefresh is set', async () => {
      db.addSession(
        'stored@example.com',
        'us1',
        'Acct',
        JSON.stringify([{ name: 'a', value: 'b' }]),
      );
      eb.BrowserManager.getInstance().getBrowser = async () => {
        throw new Error('browser should not be launched');
      };
      const cookies = await (cmd as any).getSessionCookies(1, true, { skipRefresh: true });
      assert.deepStrictEqual(cookies, [{ name: 'a', value: 'b' }]);
    });
  });

  describe('reloginWithCredentialProvider (automatic re-login safety)', () => {
    class ReloginCommand extends ConcreteTestSessionCommand {
      public calls: Array<{ headless: boolean; hasTotp: boolean }> = [];
      protected override async performLogin(
        _env: eb.Environment,
        headless: boolean,
        _u?: string,
        _p?: string,
        _a?: string,
        getTotp?: () => Promise<string | undefined>,
      ): Promise<any[]> {
        this.calls.push({ headless, hasTotp: typeof getTotp === 'function' });
        await new Promise((r) => setTimeout(r, 300));
        return [{ name: 'fresh', value: String(this.calls.length) }];
      }
      public relogin(id: number, headless: boolean) {
        return this.reloginWithCredentialProvider(id, headless);
      }
    }
    const saved = { ...process.env };
    const makeCmd = () => new ReloginCommand([], {} as any);

    beforeEach(() => {
      process.env['EB_RELOGIN_LOCK_FILE'] = path.join(tmpDir, 'relogin.lock');
      process.env['EB_USERNAME'] = 'user@example.com';
      process.env['EB_PASSWORD'] = 'pw';
      delete process.env['EB_AUTO_RELOGIN'];
      db.addSession(
        'user@example.com',
        'us2',
        'Acct',
        JSON.stringify([{ name: 'old', value: '0' }]),
      );
      db.setCredentialRef(1, 'env', 'e-Builder');
    });
    after(() => {
      process.env = saved;
    });

    it('is always headless and passes the provider TOTP (never a visible browser)', async () => {
      const c = makeCmd();
      const cookies = await c.relogin(1, false);
      assert.deepStrictEqual(cookies, [{ name: 'fresh', value: '1' }]);
      assert.deepStrictEqual(c.calls, [{ headless: true, hasTotp: true }]);
      assert.deepStrictEqual(JSON.parse(db.getSessionById(1)!.session_cookies), cookies);
    });

    it('logs in once when several re-logins race; the others reuse the saved cookies', async () => {
      const a = makeCmd();
      const b = makeCmd();
      const [ra, rb] = await Promise.all([a.relogin(1, true), b.relogin(1, true)]);
      assert.strictEqual(a.calls.length + b.calls.length, 1);
      assert.deepStrictEqual(ra, rb);
      assert.ok(!fs.existsSync(path.join(tmpDir, 'relogin.lock')), 'lock released');
    });

    it('is disabled by EB_AUTO_RELOGIN=0 and without a credential reference', async () => {
      process.env['EB_AUTO_RELOGIN'] = '0';
      const c = makeCmd();
      assert.strictEqual(await c.relogin(1, true), null);
      delete process.env['EB_AUTO_RELOGIN'];
      db.addSession('other@example.com', 'us2', 'Acct', '[]');
      assert.strictEqual(await c.relogin(2, true), null);
      assert.deepStrictEqual(c.calls, []);
    });
  });
});
