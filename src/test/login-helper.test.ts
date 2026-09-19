import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { refreshSessionIfNeeded, promptLoginAndSaveSession } from '../lib/login-helper.js';
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
      assert.strictEqual(result, false);
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
      assert.strictEqual(result, true);

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
      assert.strictEqual(result, false);
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
});
