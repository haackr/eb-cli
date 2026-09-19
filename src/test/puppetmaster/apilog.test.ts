import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  parseDetailsId,
  parseSuccess,
  extractSummariesForCurrentPage,
  downloadApiLogs,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('API Logs Scraping (src/lib/eb-puppetmaster/apilog.ts)', () => {
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;

  before(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
    await BrowserManager.getInstance().closeBrowser();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  });

  describe('parseDetailsId and parseSuccess', () => {
    it('parses details ID from onclick attribute', () => {
      const id = parseDetailsId("openLogDetails('LOG-GUID-999')");
      assert.strictEqual(id, 'LOG-GUID-999');
    });

    it('throws error when onclick does not match expected pattern', () => {
      assert.throws(
        () => parseDetailsId('invalidOnclick()'),
        /Unable to parse details id from onclick/,
      );
    });

    it('parses boolean success strings', () => {
      assert.strictEqual(parseSuccess('True'), true);
      assert.strictEqual(parseSuccess('true'), true);
      assert.strictEqual(parseSuccess('False'), false);
      assert.strictEqual(parseSuccess(''), false);
    });
  });

  describe('extractSummariesForCurrentPage', () => {
    it('scrapes summary rows from API logs table grid', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <table id="ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults">
              <tr class="RowData">
                <td>alice.smith</td>
                <td>SUP-1001</td>
                <td>2026-08-27 10:00:00</td>
                <td>2026-08-27 10:00:01</td>
                <td>True</td>
                <td><a onclick="openLogDetails('GUID-1')">View</a></td>
              </tr>
              <tr class="AltRowData">
                <td>bob.jones</td>
                <td>SUP-1002</td>
                <td>2026-08-27 10:05:00</td>
                <td>2026-08-27 10:05:02</td>
                <td>False</td>
                <td><a onclick="openLogDetails('GUID-2')">View</a></td>
              </tr>
            </table>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const summaries = await extractSummariesForCurrentPage(page, 1);
      assert.strictEqual(summaries.length, 2);

      assert.deepStrictEqual(summaries[0], {
        page: 1,
        rowOnPage: 1,
        userName: 'alice.smith',
        supportId: 'SUP-1001',
        requestTimeUtc: '2026-08-27 10:00:00',
        responseTimeUtc: '2026-08-27 10:00:01',
        success: true,
        detailsId: 'GUID-1',
      });

      assert.deepStrictEqual(summaries[1], {
        page: 1,
        rowOnPage: 2,
        userName: 'bob.jones',
        supportId: 'SUP-1002',
        requestTimeUtc: '2026-08-27 10:05:00',
        responseTimeUtc: '2026-08-27 10:05:02',
        success: false,
        detailsId: 'GUID-2',
      });
    });
  });

  describe('downloadApiLogs validation', () => {
    it('validates minimum pages constraint', async () => {
      await assert.rejects(
        async () =>
          downloadApiLogs({
            env: Environment.US1,
            cookies: [],
            pages: 0,
          }),
        /pages must be at least 1/,
      );
    });
  });
});
