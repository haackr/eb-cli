import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import BudgetitemsDelete from '../../commands/budgetitems/delete.js';
import BudgetitemsSet from '../../commands/budgetitems/set.js';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

describe('Budgetitems Commands (src/commands/budgetitems/)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-bi-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
    db.addSession(
      'test@example.com',
      'us1',
      'TestAccount',
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

  describe('BudgetitemsDelete', () => {
    it('throws error when CSV file does not exist', async () => {
      await assert.rejects(
        async () => BudgetitemsDelete.run(['nonexistent.csv', '--session-id', '1']),
        /File not found: nonexistent.csv/,
      );
    });

    it('processes CSV rows in dry-run mode and returns structured JSON', async () => {
      const csvPath = path.join(tmpDir, 'delete.csv');
      const outputCsvPath = path.join(tmpDir, 'results.csv');
      fs.writeFileSync(csvPath, 'Project ID,Item ID\nP-100,I-200\n', 'utf8');

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
            waitForNavigation: async () => {},
            waitForSelector: async () => ({}),
            $: async () => ({ click: async () => {} }),
            close: async () => {},
          }),
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await BudgetitemsDelete.run([
        csvPath,
        '--session-id',
        '1',
        '--dry-run',
        '--output-csv',
        outputCsvPath,
        '--json',
      ]);

      assert.ok(result);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.deletedCount, 1);
      assert.strictEqual(result.failedCount, 0);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].status, 'success');

      assert.ok(fs.existsSync(outputCsvPath));
      const outputCsvContent = fs.readFileSync(outputCsvPath, 'utf8');
      assert.ok(outputCsvContent.includes('P-100'));
      assert.ok(outputCsvContent.includes('I-200'));
      assert.ok(outputCsvContent.includes('success'));
    });
  });

  describe('BudgetitemsSet', () => {
    it('throws error when CSV file does not exist', async () => {
      await assert.rejects(
        async () => BudgetitemsSet.run(['nonexistent.csv', '--session-id', '1']),
        /File not found: nonexistent.csv/,
      );
    });

    it('processes budgetitems set with --dry-run and --json', async () => {
      const csvPath = path.join(tmpDir, 'set.csv');
      fs.writeFileSync(
        csvPath,
        'Project ID,Item ID,Allow Charges,Description\nP-100,I-200,true,Test Description\n',
        'utf8',
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
          cookies: async () => [{ name: 'sid', value: '1' }],
          close: async () => {},
        }),
        defaultBrowserContext: () => ({
          setCookie: async () => {},
          newPage: async () => ({
            setDefaultNavigationTimeout: () => {},
            setDefaultTimeout: () => {},
            goto: async () => {},
            waitForNavigation: async () => {},
            waitForSelector: async () => ({
              click: async () => {},
              getProperty: async () => ({ jsonValue: async () => false }),
            }),
            $: async () => ({ click: async () => {} }),
            $eval: async () => {},
            close: async () => {},
          }),
        }),
      };

      eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

      const result = await BudgetitemsSet.run([
        csvPath,
        '--session-id',
        '1',
        '--dry-run',
        '--json',
      ]);

      assert.ok(result);
      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.updatedCount, 1);
      assert.strictEqual(result.failedCount, 0);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].status, 'success');
    });
  });
});
