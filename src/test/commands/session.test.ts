import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SessionList from '../../commands/session/list.js';
import SessionTest from '../../commands/session/test.js';
import SessionExec from '../../commands/session/exec.js';
import Logout from '../../commands/logout.js';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

describe('Session Commands (src/commands/session/)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-session-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);

    originalGetBrowser = eb.BrowserManager.getInstance().getBrowser;
    originalCloseBrowser = eb.BrowserManager.getInstance().closeBrowser;
    eb.BrowserManager.getInstance().closeBrowser = async () => {};
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  after(() => {
    process.exitCode = 0;
    eb.BrowserManager.getInstance().getBrowser = originalGetBrowser;
    eb.BrowserManager.getInstance().closeBrowser = originalCloseBrowser;
    db.closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('SessionList', () => {
    it('returns empty array when --json is passed and no sessions exist', async () => {
      const result = await SessionList.run(['--json']);
      assert.deepStrictEqual(result, []);
    });

    it('returns session objects when --json is passed and sessions exist', async () => {
      db.addSession('alice@example.com', 'us1', 'AccountA', '[]');
      db.addSession('bob@example.com', 'us2', 'AccountB', '[]');

      const result = await SessionList.run(['--json']);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].username, 'alice@example.com');
      assert.strictEqual(result[0].environment, 'us1');
      assert.strictEqual(result[1].username, 'bob@example.com');
    });

    it('filters sessions by username with --username', async () => {
      db.addSession('charlie@example.com', 'gov', 'Acct1', '[]');
      db.addSession('dave@example.com', 'ca', 'Acct2', '[]');

      const result = await SessionList.run(['--json', '--username', 'charlie@example.com']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].username, 'charlie@example.com');
    });
  });

  describe('SessionTest', () => {
    it('handles testing when no sessions exist', async () => {
      await assert.doesNotReject(async () => {
        await SessionTest.run([]);
      });
    });

    it('refreshes valid sessions and updates cookies in DB', async () => {
      db.addSession(
        'active@example.com',
        'us1',
        'Acct1',
        JSON.stringify([{ name: 'c1', value: 'v1' }]),
      );

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForSelector: async () => ({}),
          }),
          setCookie: async () => {},
          cookies: async () => [{ name: 'c1', value: 'refreshed_v2' }],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      await SessionTest.run([]);

      const sessions = db.getSessions();
      assert.strictEqual(sessions.length, 1);
      assert.deepStrictEqual(JSON.parse(sessions[0]!.session_cookies), [
        { name: 'c1', value: 'refreshed_v2' },
      ]);
    });

    it('deletes invalid sessions from the database', async () => {
      db.addSession('invalid@example.com', 'us1', 'Acct1', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForSelector: async () => {
              throw new Error('Not logged in');
            },
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      await SessionTest.run([]);

      const sessions = db.getSessions();
      assert.strictEqual(sessions.length, 0);
    });

    it('returns structured JSON array and retains sessions when --no-delete is passed', async () => {
      db.addSession('retained@example.com', 'us1', 'Acct1', '[]');

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

      const results: any = await SessionTest.run(['--json', '--no-delete']);

      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].username, 'retained@example.com');
      assert.strictEqual(results[0].valid, false);
      assert.strictEqual(results[0].deleted, false);

      const sessions = db.getSessions();
      assert.strictEqual(sessions.length, 1);
    });
  });

  describe('Logout', () => {
    it('logs out a specific session by --session-id', async () => {
      db.addSession('user@example.com', 'us1', 'Acct', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
          }),
          setCookie: async () => {},
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      await Logout.run(['--session_id', '1']);

      const sessions = db.getSessions();
      assert.strictEqual(sessions.length, 0);
    });

    it('logs out all sessions when --all is specified', async () => {
      db.addSession('u1@example.com', 'us1', 'A1', '[]');
      db.addSession('u2@example.com', 'us2', 'A2', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
          }),
          setCookie: async () => {},
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      await Logout.run(['--all']);

      const sessions = db.getSessions();
      assert.strictEqual(sessions.length, 0);
    });
  });

  describe('SessionExec', () => {
    it('executes a DOM script against a stored session and returns JSON', async () => {
      db.addSession(
        'admin@example.com',
        'us1',
        'AdminAcct',
        JSON.stringify([{ name: 'sid', value: 'initial' }]),
      );

      let navigatedUrls: string[] = [];

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async (url: string) => {
              navigatedUrls.push(url);
            },
            url: () => 'https://app.e-builder.net/da2/Processes/ProcessesView.aspx',
            title: async () => 'Processes View',
            waitForSelector: async () => ({}),
            waitForFunction: async () => ({}),
            waitForNetworkIdle: async () => ({}),
            evaluate: async (fn: any) => {
              const fnStr = String(fn);
              if (fnStr.includes('innerHref')) {
                return { docTitle: 'Processes View', innerHref: null };
              }
              return { extracted: ['Field A', 'Field B'] };
            },
            close: async () => {},
          }),
          setCookie: async () => {},
          cookies: async () => [{ name: 'sid', value: 'updated_cookie' }],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result: any = await SessionExec.run([
        '/da2/Processes/ProcessesView.aspx',
        '--session-id',
        '1',
        '--eval',
        '(() => ({ extracted: ["Field A", "Field B"] }))()',
        '--json',
      ]);

      assert.strictEqual(result.session.username, 'admin@example.com');
      assert.strictEqual(result.session.origin, 'https://app.e-builder.net');
      assert.strictEqual(result.url, 'https://app.e-builder.net/da2/Processes/ProcessesView.aspx');
      assert.deepStrictEqual(result.result, { extracted: ['Field A', 'Field B'] });
      assert.ok(
        navigatedUrls.includes('https://app.e-builder.net/da2/Processes/ProcessesView.aspx'),
      );

      const updatedSession = db.getSessionById(1);
      assert.deepStrictEqual(JSON.parse(updatedSession!.session_cookies), [
        { name: 'sid', value: 'updated_cookie' },
      ]);
    });

    it('returns structured inspection AST when --inspect is passed with --json', async () => {
      db.addSession('inspect_user@example.com', 'us1', 'Acct', '[]');

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            url: () => 'https://app.e-builder.net/da2/Home/index2.aspx',
            title: async () => 'Home',
            waitForSelector: async () => ({}),
            waitForFunction: async () => ({}),
            waitForNetworkIdle: async () => ({}),
            evaluate: async (fn: any) => {
              const fnStr = String(fn);
              if (fnStr.includes('innerHref')) {
                return { docTitle: 'Home', innerHref: null };
              }
              // Return inspection AST
              return {
                title: 'Home',
                url: 'https://app.e-builder.net/da2/Home/index2.aspx',
                breadcrumbs: ['Home'],
                fields: [{ name: 'search', type: 'text', label: 'Search' }],
                actions: [{ text: 'Go', type: 'submit' }],
                tables: [],
                alerts: [],
              };
            },
            close: async () => {},
          }),
          setCookie: async () => {},
          cookies: async () => [],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result: any = await SessionExec.run(['/da2/Home/index2.aspx', '--inspect', '--json']);

      assert.strictEqual(result.success, true);
      assert.ok(result.inspection);
      assert.strictEqual(result.inspection.title, 'Home');
      assert.strictEqual(result.inspection.fields[0].name, 'search');
    });

    it('returns structured failure payload on error instead of unhandled crash when --json is passed', async () => {
      db.addSession(
        'err_user@example.com',
        'us1',
        'Acct',
        JSON.stringify([{ name: 'sid', value: '123' }]),
      );

      const mockBrowser: any = {
        connected: true,
        createBrowserContext: async () => ({
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async (url: string) => {
              if (url.includes('bad-page')) {
                throw new Error('Navigation failed: timeout 30000ms');
              }
            },
            waitForSelector: async () => ({}),
            waitForFunction: async () => ({}),
            waitForNetworkIdle: async () => ({}),
            url: () => 'https://app.e-builder.net/bad-page',
            title: async () => 'Error',
            close: async () => {},
          }),
          setCookie: async () => {},
          cookies: async () => [{ name: 'sid', value: '123' }],
          close: async () => {},
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result: any = await SessionExec.run(['/bad-page', '--json']);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.match(result.error.message, /Navigation failed/);
    });
  });
});
