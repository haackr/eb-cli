import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import UserSetSso from '../../commands/users/setsso.js';
import UserSetField from '../../commands/users/setfield.js';
import UserDelete from '../../commands/users/delete.js';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

describe('User Commands (src/commands/users/)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-users-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
    db.addSession(
      'admin@example.com',
      'us1',
      'MainAccount',
      JSON.stringify([{ name: 'sid', value: '1' }]),
    );

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

  describe('UserSetSso', () => {
    it('throws error when CSV file does not exist', async () => {
      await assert.rejects(
        async () => UserSetSso.run(['missing.csv', '--session-id', '1']),
        /File not found: missing.csv/,
      );
    });

    it('processes SSO toggles with --dry-run and returns JSON payload', async () => {
      const csvPath = path.join(tmpDir, 'sso.csv');
      fs.writeFileSync(csvPath, 'User ID,Single Sign-On\n1001,true\n1002,false\n', 'utf8');

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
          cookies: async () => [{ name: 'sid', value: '1' }],
          close: async () => {},
        }),
        defaultBrowserContext: () => ({
          setCookie: async () => {},
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            url: () =>
              'https://app.e-builder.net/da2/Setup/Admin/Users/AddEditUser.aspx?UserID=1001',
            evaluate: async () => ({ found: true }),
            $: async () => ({ click: async () => {} }),
            close: async () => {},
          }),
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await UserSetSso.run([csvPath, '--session-id', '1', '--dry-run', '--json']);

      assert.ok(result);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.updatedCount, 2);
      assert.strictEqual(result.failedCount, 0);
      assert.strictEqual(result.results.length, 2);
    });
  });

  describe('UserSetField', () => {
    it('throws error when CSV file does not exist', async () => {
      await assert.rejects(
        async () => UserSetField.run(['missing.csv', '--session-id', '1']),
        /File not found: missing.csv/,
      );
    });

    it('processes user field updates with --dry-run and returns JSON', async () => {
      const csvPath = path.join(tmpDir, 'fields.csv');
      fs.writeFileSync(csvPath, 'User ID,First Name,Company\n2001,John,Acme\n', 'utf8');

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
          cookies: async () => [{ name: 'sid', value: '1' }],
          close: async () => {},
        }),
        defaultBrowserContext: () => ({
          setCookie: async () => {},
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            url: () =>
              'https://app.e-builder.net/da2/Setup/Admin/Users/AddEditUser.aspx?UserID=2001',
            evaluate: async () => ({
              updatedFields: ['First Name', 'Company'],
              notFoundFields: [],
            }),
            $: async () => ({ click: async () => {} }),
            close: async () => {},
          }),
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await UserSetField.run([csvPath, '--session-id', '1', '--dry-run', '--json']);

      assert.ok(result);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.updatedCount, 1);
      assert.strictEqual(result.failedCount, 0);
    });
  });

  describe('UserDelete', () => {
    it('throws error when CSV file does not exist', async () => {
      await assert.rejects(
        async () => UserDelete.run(['missing.csv', '--session-id', '1']),
        /File not found: missing.csv/,
      );
    });

    it('executes user deletion in dry-run mode', async () => {
      const csvPath = path.join(tmpDir, 'users_to_delete.csv');
      fs.writeFileSync(csvPath, 'Username\nold.user@example.com\n', 'utf8');

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
          cookies: async () => [{ name: 'sid', value: '1' }],
          close: async () => {},
        }),
        defaultBrowserContext: () => ({
          setCookie: async () => {},
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            url: () => 'https://app.e-builder.net/da2/Setup/Admin/Users/ManageUsers.aspx',
            locator: () => ({
              fill: async () => {},
              click: async () => {},
            }),
            waitForNavigation: async () => {},
            close: async () => {},
          }),
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await UserDelete.run([csvPath, '--session-id', '1', '--dry-run', '--json']);

      assert.ok(result);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.deletedCount, 1);
      assert.strictEqual(result.failedCount, 0);
    });
  });
});
