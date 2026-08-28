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

    it('throws when session has expired and cannot be refreshed', async () => {
      db.addSession('expired@example.com', 'us1', 'Acct', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForSelector: async () => {
              throw new Error('Timeout');
            },
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      await assert.rejects(
        async () => cmd.publicGetSessionCookies(1, true),
        /CLI Error: Session has expired. Please log in again using 'eb login'./,
      );
    });
  });
});
