import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ProcessSetNullField from '../../commands/process/setnullfield.js';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

describe('Process Command (src/commands/process/setnullfield.ts)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-proc-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
    db.addSession(
      'proc_user@example.com',
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

  it('throws error when CSV file does not exist', async () => {
    await assert.rejects(
      async () => ProcessSetNullField.run(['missing.csv', '--session-id', '1']),
      /File not found: missing.csv/,
    );
  });

  it('executes process field nulling with --dry-run and returns JSON results', async () => {
    const csvPath = path.join(tmpDir, 'process_fields.csv');
    fs.writeFileSync(csvPath, 'Instance ID,Field 1,Field 2\nPROC-101,Description,Notes\n', 'utf8');

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
          url: () => 'https://app.e-builder.net/instancedetails.aspx?instanceid=PROC-101',
          on: () => {},
          evaluate: async () => ({
            hasDataFieldsSection: true,
            hasDataFieldRows: true,
            hasProcessTitle: true,
            clearedFields: ['Description', 'Notes'],
            notFoundFields: [],
          }),
          waitForSelector: async () => ({}),
          waitForFunction: async () => ({}),
          waitForNetworkIdle: async () => ({}),
          $: async () => ({ click: async () => {} }),
          close: async () => {},
        }),
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const result = await ProcessSetNullField.run([
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
    assert.strictEqual(result.results[0].processInstanceId, 'PROC-101');
    assert.deepStrictEqual(result.results[0].clearedFields, ['Description', 'Notes']);
  });
});
