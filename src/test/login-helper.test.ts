import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  refreshSessionIfNeeded,
  promptLoginAndSaveSession,
  finalizeSession,
  saveRefreshedSession,
  SessionVerificationError,
  promptImportAndSaveSession,
  chooseLoginMode,
} from '../lib/login-helper.js';
import * as db from '../lib/db.js';
import * as eb from '../lib/eb-puppetmaster/index.js';

describe('Login Helper (src/lib/login-helper.ts)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-login-helper-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
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

  describe('refreshSessionIfNeeded', () => {
    it('returns false when session is not in the database', async () => {
      const result = await refreshSessionIfNeeded(999);
      assert.strictEqual(result.isLoggedIn, false);
      assert.strictEqual(result.reason, 'unknown');
    });

    it('updates session cookies in DB and returns true when session is valid', async () => {
      db.addSession(
        'valid@example.com',
        'us1',
        'Acct1',
        JSON.stringify([{ name: 'old', value: '1' }]),
      );

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
          cookies: async () => [{ name: 'new', value: '2' }],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await refreshSessionIfNeeded(1, true);
      assert.strictEqual(result.isLoggedIn, true);
      assert.strictEqual(result.reason, 'authenticated');

      const session = db.getSessionById(1);
      assert.ok(session);
      assert.deepStrictEqual(JSON.parse(session.session_cookies), [{ name: 'new', value: '2' }]);
    });

    it('returns false when session check fails', async () => {
      db.addSession('invalid@example.com', 'us1', 'Acct1', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForSelector: async () => {
              throw new Error('Timeout selector not found');
            },
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await refreshSessionIfNeeded(1, true);
      assert.strictEqual(result.isLoggedIn, false);
    });

    it('reports network_error (not expiry) and keeps cookies when e-Builder is unreachable', async () => {
      db.addSession(
        'offline@example.com',
        'us1',
        'Acct1',
        JSON.stringify([{ name: 'keep', value: '1' }]),
      );

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            url: () => 'about:blank',
            goto: async () => {
              throw new Error(
                'net::ERR_NAME_NOT_RESOLVED at https://app.e-builder.net/da2/Home/index2.aspx',
              );
            },
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      };
      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await refreshSessionIfNeeded(1, true);
      assert.strictEqual(result.isLoggedIn, false);
      assert.strictEqual(result.reason, 'network_error');
      const session = db.getSessionById(1);
      assert.deepStrictEqual(JSON.parse(session!.session_cookies), [{ name: 'keep', value: '1' }]);
    });
  });

  describe('promptLoginAndSaveSession', () => {
    it('throws error for unknown environment', async () => {
      await assert.rejects(
        async () => promptLoginAndSaveSession({ environment: 'invalid_env' }),
        /Unknown environment: invalid_env/,
      );
    });
  });

  describe('finalizeSession', () => {
    const verifiedBrowser = (
      authenticated: boolean,
      newCookies: any[] = [{ name: 'fresh', value: '1' }],
    ) =>
      ({
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            url: () =>
              authenticated
                ? 'https://app.e-builder.net/da2/Home/index2.aspx'
                : 'https://app.e-builder.net/Login/Login.aspx?ReturnUrl=%2fda2',
            goto: async () => ({ status: () => 200 }),
            waitForSelector: async () => {
              if (authenticated) return {};
              throw new Error('Not found');
            },
            evaluate: async () => false,
            $: async () => null,
          }),
          setCookie: async () => {},
          cookies: async () => newCookies,
          close: async () => {},
        }),
      }) as any;

    const identity = (i: Partial<eb.SessionIdentity>) => async () => i;

    it('saves the identity e-Builder reports, ignoring weaker hints', async () => {
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true);
      const saved = await finalizeSession(
        eb.Environment.US2,
        [{ name: 'old', value: '0' }],
        { username: 'typed', account: 'From dropdown' },
        {
          interactive: false,
          identify: identity({
            username: 'jane@example.com',
            accountName: 'Acme',
            accountId: 'acct-1',
          }),
        },
      );
      assert.deepStrictEqual(saved, {
        sessionId: 1,
        username: 'jane@example.com',
        account: 'Acme',
        accountId: 'acct-1',
        updatedExisting: false,
      });
      const row = db.getSessionById(1)!;
      assert.strictEqual(row.environment, 'us2');
      assert.strictEqual(row.account_id, 'acct-1');
      assert.deepStrictEqual(JSON.parse(row.session_cookies), [{ name: 'fresh', value: '1' }]);
    });

    it('falls back to hints when e-Builder cannot be read', async () => {
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true);
      const saved = await finalizeSession(
        eb.Environment.US1,
        [],
        { username: 'jane@example.com', account: 'Picked' },
        { interactive: false, identify: identity({}) },
      );
      assert.strictEqual(saved.username, 'jane@example.com');
      assert.strictEqual(saved.account, 'Picked');
      assert.strictEqual(saved.accountId, null);
    });

    const sid = (v: string) => ({
      name: 'ASP.NET_SessionId',
      value: v,
      domain: 'app-us2.e-builder.net',
    });
    const jane = identity({
      username: 'jane@example.com',
      accountName: 'Acme',
      accountId: 'acct-1',
    });

    it('updates the stored row only when it holds the same e-Builder login', async () => {
      db.addSession('jane@example.com', 'us2', '', JSON.stringify([sid('S1')]), 'acct-1');
      db.setCredentialRef(1, 'env', 'e-Builder');
      // isLoggedIn hands back refreshed cookies that still carry the same ASP.NET session id.
      eb.BrowserManager.getInstance().getBrowser = async () =>
        verifiedBrowser(true, [
          sid('S1'),
          { name: '.ASPXAUTH', value: 'reissued', domain: 'app-us2.e-builder.net' },
        ]);
      const saved = await finalizeSession(
        eb.Environment.US2,
        [sid('S1')],
        {},
        {
          interactive: false,
          identify: jane,
        },
      );
      assert.strictEqual(saved.sessionId, 1);
      assert.strictEqual(saved.updatedExisting, true);
      assert.strictEqual(db.getSessions().length, 1);
      assert.strictEqual(db.getSessionById(1)!.account, 'Acme');
      assert.ok(db.getCredentialRef(1), 'credential ref stays attached');
    });

    it('keeps the old row for a different login of the same user and account', async () => {
      const old = JSON.stringify([sid('S1')]);
      db.addSession('jane@example.com', 'us2', 'Acme', old, 'acct-1');
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true, [sid('S2')]);
      const saved = await finalizeSession(
        eb.Environment.US2,
        [sid('S2')],
        {},
        {
          interactive: false,
          identify: jane,
        },
      );
      assert.strictEqual(saved.sessionId, 2);
      assert.strictEqual(saved.updatedExisting, false);
      assert.strictEqual(
        db.getSessionById(1)!.session_cookies,
        old,
        'old login left intact to log out later',
      );
    });

    it('never matches across environments or without a session id', async () => {
      db.addSession(
        'jane@example.com',
        'us1',
        'Acme',
        JSON.stringify([{ ...sid('S1'), domain: 'app.e-builder.net' }]),
        'acct-1',
      );
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true, [sid('S1')]);
      const a = await finalizeSession(
        eb.Environment.US2,
        [sid('S1')],
        {},
        { interactive: false, identify: jane },
      );
      assert.strictEqual(a.updatedExisting, false);
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true, []);
      const b = await finalizeSession(
        eb.Environment.US2,
        [],
        {},
        { interactive: false, identify: jane },
      );
      assert.strictEqual(b.updatedExisting, false);
      assert.strictEqual(db.getSessions().length, 3);
    });

    it('throws SessionVerificationError and saves nothing when cookies are not authenticated', async () => {
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(false);
      await assert.rejects(
        finalizeSession(
          eb.Environment.US1,
          [],
          { username: 'x' },
          { interactive: false, identify: identity({}) },
        ),
        SessionVerificationError,
      );
      assert.strictEqual(db.getSessions().length, 0);
    });

    it('requires a username when it cannot be detected and prompting is off', async () => {
      eb.BrowserManager.getInstance().getBrowser = async () => verifiedBrowser(true);
      await assert.rejects(
        finalizeSession(eb.Environment.US1, [], {}, { interactive: false, identify: identity({}) }),
        /--username/,
      );
    });
  });

  describe('saveRefreshedSession', () => {
    it('backfills a blank account name and missing account id', async () => {
      db.addSession('jane@example.com', 'us2', '', '[]');
      await saveRefreshedSession(db.getSessionById(1)!, [{ name: 'n', value: '1' }], async () => ({
        accountName: 'Acme',
        accountId: 'acct-1',
      }));
      const row = db.getSessionById(1)!;
      assert.strictEqual(row.account, 'Acme');
      assert.strictEqual(row.account_id, 'acct-1');
      assert.deepStrictEqual(JSON.parse(row.session_cookies), [{ name: 'n', value: '1' }]);
    });

    it('keeps a user-set account name and skips lookups once identity is complete', async () => {
      db.addSession('jane@example.com', 'us2', 'My Nickname', '[]');
      await saveRefreshedSession(db.getSessionById(1)!, [], async () => ({
        accountName: 'Acme',
        accountId: 'acct-1',
      }));
      assert.strictEqual(db.getSessionById(1)!.account, 'My Nickname');
      assert.strictEqual(db.getSessionById(1)!.account_id, 'acct-1');

      let called = false;
      await saveRefreshedSession(db.getSessionById(1)!, [], async () => {
        called = true;
        return {};
      });
      assert.strictEqual(called, false);
    });
  });

  describe('promptImportAndSaveSession', () => {
    const okBrowser = () =>
      ({
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            url: () => 'https://app-us2.e-builder.net/da2/Home/index2.aspx',
            goto: async () => ({ status: () => 200 }),
            waitForSelector: async () => ({}),
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      }) as any;
    const chromeJar = [
      { name: '.ASPXAUTH', value: 'a2', domain: 'app-us2.e-builder.net' },
      { name: '_ga', value: 'ga', domain: '.e-builder.net' },
      { name: '.ASPXAUTH', value: 'a1', domain: 'app.e-builder.net' },
    ] as any[];

    it('imports the requested environment with only its cookies and the detected identity', async () => {
      eb.BrowserManager.getInstance().getBrowser = async () => okBrowser();
      eb.BrowserManager.getInstance().closeBrowser = async () => {};
      let identifiedWith: any[] = [];
      const saved = await promptImportAndSaveSession({
        environment: 'us2',
        readCookies: async () => chromeJar,
        finalize: {
          interactive: false,
          identify: async (_env, cookies) => {
            identifiedWith = cookies as any[];
            return { username: 'jane@example.com', accountName: 'Acme', accountId: 'acct-1' };
          },
        },
      });
      assert.strictEqual(saved.username, 'jane@example.com');
      assert.strictEqual(saved.account, 'Acme');
      assert.deepStrictEqual(
        identifiedWith.map((c) => c.value),
        ['a2', 'ga'],
      );
      const row = db.getSessionById(saved.sessionId)!;
      assert.strictEqual(row.environment, 'us2');
      assert.deepStrictEqual(
        JSON.parse(row.session_cookies).map((c: any) => c.value),
        ['a2', 'ga'],
      );
    });

    it('requires --environment when Chrome has several and prompting is off', async () => {
      await assert.rejects(
        promptImportAndSaveSession({
          readCookies: async () => chromeJar,
          finalize: { interactive: false },
        }),
        /several e-Builder environments \(US-1, US-2\); pass --environment/,
      );
    });

    it('explains when Chrome has no session for the requested environment', async () => {
      await assert.rejects(
        promptImportAndSaveSession({
          environment: 'us3',
          readCookies: async () => chromeJar,
          finalize: { interactive: false },
        }),
        /no e-Builder session for US-3\. Found: US-1, US-2/,
      );
      await assert.rejects(
        promptImportAndSaveSession({
          readCookies: async () => [],
          finalize: { interactive: false },
        }),
        /no signed-in e-Builder session/,
      );
    });
  });

  describe('chooseLoginMode', () => {
    it('defaults to the browser unless a password or provider is given', () => {
      assert.strictEqual(chooseLoginMode({}), 'browser');
      assert.strictEqual(chooseLoginMode({ username: 'jane' }), 'browser');
      assert.strictEqual(chooseLoginMode({ password: 'x' }), 'credentials');
      assert.strictEqual(chooseLoginMode({ getTotp: async () => '1' }), 'credentials');
      assert.strictEqual(chooseLoginMode({ browser: false }), 'credentials');
      assert.strictEqual(chooseLoginMode({ browser: true, password: 'x' }), 'browser');
      assert.strictEqual(chooseLoginMode({ ssoUrl: 'https://idp', browser: false }), 'sso');
    });
  });

  describe('promptLoginAndSaveSession (browser mode)', () => {
    it('captures the session from the window without prompting for credentials', async () => {
      const landed = 'https://app-us2.e-builder.net/da2/Home/index2.aspx';
      const page: any = {
        setDefaultNavigationTimeout: () => {},
        setDefaultTimeout: () => {},
        goto: async () => ({ status: () => 200 }),
        url: () => landed,
        evaluate: async () => false,
        waitForSelector: async () => ({}),
      };
      const browser: any = {
        connected: true,
        pages: async () => [page],
        cookies: async () => [{ name: 'c', value: '1' }],
        createBrowserContext: async () => ({
          newPage: async () => page,
          setCookie: async () => {},
          cookies: async () => [{ name: 'c', value: '2' }],
          close: async () => {},
        }),
      };
      const launches: boolean[] = [];
      eb.BrowserManager.getInstance().getBrowser = async (headless?: boolean) => {
        launches.push(Boolean(headless));
        return browser;
      };
      eb.BrowserManager.getInstance().closeBrowser = async () => {};

      const saved = await promptLoginAndSaveSession({
        environment: 'us1',
        username: 'jane@example.com',
      });
      assert.deepStrictEqual(
        launches,
        [false, true],
        'visible login window, then headless verification',
      );
      assert.strictEqual(saved.username, 'jane@example.com');
      assert.strictEqual(
        db.getSessionById(saved.sessionId)!.environment,
        'us2',
        'environment from where the user landed',
      );
    });
  });
});
