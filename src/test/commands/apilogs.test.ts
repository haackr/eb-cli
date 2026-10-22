import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ApiLogsDownload from '../../commands/apilogs/download.js';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';

describe('API Logs Command (src/commands/apilogs/download.ts)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-apilogs-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
    db.addSession(
      'api_user@example.com',
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

  it('errors when output file already exists without --overwrite flag', async () => {
    const existingFile = path.join(tmpDir, 'existing.jsonl');
    fs.writeFileSync(existingFile, '{"dummy":true}\n', 'utf8');

    await assert.rejects(
      async () => ApiLogsDownload.run(['--session-id', '1', '--output-file', existingFile]),
      /Output file already exists/,
    );
  });

  it('downloads logs and writes jsonl output in --json mode', async () => {
    const outputFile = path.join(tmpDir, 'downloaded.jsonl');

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
          waitForSelector: async () => ({}),
          $$eval: async () => [],
          $: async () => null,
          close: async () => {},
        }),
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const result = await ApiLogsDownload.run([
      '--session-id',
      '1',
      '--pages',
      '1',
      '--output-file',
      outputFile,
      '--json',
    ]);

    assert.ok(result);
    assert.strictEqual(result.pagesRequested, 1);
    assert.strictEqual(result.pagesProcessed, 1);
    assert.strictEqual(result.recordsDownloaded, 0);
    const expectedRange = eb.getDefaultApiLogDateRange();
    assert.strictEqual(result.fromDate, expectedRange.fromDate);
    assert.strictEqual(result.toDate, expectedRange.toDate);
    assert.ok(fs.existsSync(outputFile));
  });

  it('accepts custom --from-date and --to-date flags', async () => {
    const outputFile = path.join(tmpDir, 'custom-dates.jsonl');

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
          waitForSelector: async () => ({}),
          $$eval: async () => [],
          $: async () => null,
          close: async () => {},
        }),
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const result = await ApiLogsDownload.run([
      '--session-id',
      '1',
      '--pages',
      '1',
      '--from-date',
      '2026-08-01',
      '--to-date',
      '2026-08-15',
      '--output-file',
      outputFile,
      '--json',
    ]);

    assert.ok(result);
    assert.strictEqual(result.fromDate, '08/01/2026');
    assert.strictEqual(result.toDate, '08/15/2026');
    assert.ok(fs.existsSync(outputFile));
  });

  it('rejects invalid date strings', async () => {
    await assert.rejects(
      async () => ApiLogsDownload.run(['--session-id', '1', '--from-date', 'invalid-date']),
      /Invalid --from-date/,
    );

    await assert.rejects(
      async () => ApiLogsDownload.run(['--session-id', '1', '--to-date', '99/99/9999']),
      /Invalid --to-date/,
    );
  });

  it('rejects when from-date is after to-date', async () => {
    await assert.rejects(
      async () =>
        ApiLogsDownload.run([
          '--session-id',
          '1',
          '--from-date',
          '2026-09-15',
          '--to-date',
          '2026-09-01',
        ]),
      /must be before or equal to/,
    );
  });
});
