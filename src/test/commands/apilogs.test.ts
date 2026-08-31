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

    const mockContext = {
      addCookies: async () => {},
      cookies: async () => [{ name: 'sid', value: '1' }],
      close: async () => {},
      newPage: async () => ({
        setDefaultNavigationTimeout: () => {},
        setDefaultTimeout: () => {},
        goto: async () => {},
        waitForSelector: async () => ({}),
        $$eval: async () => [],
        $: async () => null,
        evaluate: async () => [],
        close: async () => {},
      }),
    };

    const mockBrowser: any = {
      isConnected: () => true,
      contexts: () => [mockContext],
      newContext: async () => mockContext,
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
    assert.ok(fs.existsSync(outputFile));
  });
});
