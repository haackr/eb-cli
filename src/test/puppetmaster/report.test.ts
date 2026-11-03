import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import {
  saveCachedReportCatalog,
  getCachedReportCatalog,
  type ReportSummaryItem,
} from '../../lib/eb-puppetmaster/report.js';
import ReportsList from '../../commands/reports/list.js';
import ReportsImportConfig from '../../commands/reports/import-config.js';

describe('Report Engine & Replicator (src/lib/eb-puppetmaster/report.ts)', () => {
  let tmpDir: string;
  let originalGetBrowser: any;
  let originalCloseBrowser: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-rep-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);

    originalGetBrowser = eb.BrowserManager.getInstance().getBrowser;
    originalCloseBrowser = eb.BrowserManager.getInstance().closeBrowser;
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  after(() => {
    eb.BrowserManager.getInstance().getBrowser = originalGetBrowser;
    eb.BrowserManager.getInstance().closeBrowser = originalCloseBrowser;
    db.closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('caches and retrieves report catalog from SQLite', () => {
    const mockReports: ReportSummaryItem[] = [
      { id: 'rep-1', name: 'Cost Summary Report', category: 'Cost', description: 'Monthly cost' },
      { id: 'rep-2', name: 'Open Change Orders', category: 'Process', description: 'Pending CCOs' },
    ];

    saveCachedReportCatalog('us1', 'Acct1', mockReports);

    const cached = getCachedReportCatalog('us1', 'Acct1');
    assert.ok(cached);
    assert.strictEqual(cached.length, 2);
    assert.strictEqual(cached[0]?.name, 'Cost Summary Report');
  });

  it('ReportsList filters reports by search keyword and category with --json', async () => {
    db.addSession('user@example.com', 'us1', 'Acct1', '[]');
    const mockReports: ReportSummaryItem[] = [
      { id: 'rep-1', name: 'Project Budget', category: 'Cost' },
      { id: 'rep-2', name: 'Process Aging', category: 'Process' },
    ];
    saveCachedReportCatalog('us1', 'Acct1', mockReports);

    const listResult: any = await ReportsList.run(['--search', 'Budget', '--json']);
    assert.strictEqual(listResult.length, 1);
    assert.strictEqual(listResult[0].name, 'Project Budget');
  });

  it('ReportsImportConfig rejects pre-0.2 config files before touching the browser', async () => {
    db.addSession('user@example.com', 'us2', 'Acct1', '[]');
    const file = path.join(tmpDir, 'old-format.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ name: 'Old', category: 'Cost', dataSource: 'Commitments', columns: [] }),
    );
    eb.BrowserManager.getInstance().getBrowser = async () => {
      throw new Error('browser must not be launched for an invalid config');
    };

    await assert.rejects(
      ReportsImportConfig.run([file, '--session-id', '1']),
      /Unsupported report config format/,
    );
  });
});
