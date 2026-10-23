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
import ReportsExportConfig from '../../commands/reports/export-config.js';
import ReportsCopy from '../../commands/reports/copy.js';

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

  it('ReportsExportConfig exports portable report AST', async () => {
    db.addSession(
      'user@example.com',
      'us1',
      'Acct1',
      JSON.stringify([{ name: 'sid', value: '123' }]),
    );

    const mockBrowser: any = {
      connected: true,
      createBrowserContext: async () => ({
        newPage: async () => ({
          setDefaultNavigationTimeout: () => {},
          setDefaultTimeout: () => {},
          goto: async () => {},
          waitForSelector: async () => ({}),
          waitForFunction: async () => ({}),
          waitForNetworkIdle: async () => ({}),
          evaluate: async () => ({
            name: 'Budget Summary',
            description: 'Exported report',
            category: 'Cost',
            dataSource: 'Commitments',
            columns: [
              { field: 'Item Identifier', header: 'Item ID' },
              { field: 'Amount', header: 'Total Amount' },
            ],
          }),
          close: async () => {},
        }),
        setCookie: async () => {},
        cookies: async () => [{ name: 'sid', value: '123' }],
        close: async () => {},
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const config: any = await ReportsExportConfig.run(['101', '--json']);

    assert.ok(config);
    assert.strictEqual(config.name, 'Budget Summary');
    assert.strictEqual(config.dataSource, 'Commitments');
    assert.strictEqual(config.columns.length, 2);
  });

  it('ReportsCopy clones report definition between two distinct sessions', async () => {
    db.addSession(
      'source@example.com',
      'us1',
      'SourceAcct',
      JSON.stringify([{ name: 's1', value: 'v1' }]),
    );
    db.addSession(
      'target@example.com',
      'us2',
      'TargetAcct',
      JSON.stringify([{ name: 's2', value: 'v2' }]),
    );

    let createdReportCalled = false;
    const mockBrowser: any = {
      connected: true,
      createBrowserContext: async () => ({
        newPage: async () => ({
          setDefaultNavigationTimeout: () => {},
          setDefaultTimeout: () => {},
          goto: async () => {},
          waitForSelector: async () => ({}),
          waitForFunction: async () => ({}),
          waitForNetworkIdle: async () => ({}),
          url: () =>
            'https://app-us2.e-builder.net/da2/Reports/ReportDesigner.aspx?ReportID=new-999',
          evaluate: async (fn: any) => {
            const fnStr = String(fn);
            if (fnStr.includes('submitted')) {
              createdReportCalled = true;
              return { submitted: true };
            }
            return {
              name: 'Original Report',
              category: 'Cost',
              dataSource: 'Commitments',
              columns: [{ field: 'ID', header: 'ID' }],
            };
          },
          close: async () => {},
        }),
        setCookie: async () => {},
        cookies: async () => [{ name: 's', value: 'v' }],
        close: async () => {},
      }),
    };

    eb.BrowserManager.getInstance().getBrowser = async () => mockBrowser;

    const copyResult: any = await ReportsCopy.run([
      '--from-session',
      '1',
      '--to-session',
      '2',
      '--report-id',
      'rep-500',
      '--name',
      'Cloned in Target',
      '--json',
    ]);

    assert.ok(copyResult);
    assert.strictEqual(copyResult.success, true);
    assert.strictEqual(copyResult.reportName, 'Cloned in Target');
    assert.strictEqual(copyResult.fromSession.account, 'SourceAcct');
    assert.strictEqual(copyResult.toSession.account, 'TargetAcct');
    assert.strictEqual(createdReportCalled, true);
  });
});
