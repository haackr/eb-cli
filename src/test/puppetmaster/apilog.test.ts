import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  parseDetailsId,
  parseSuccess,
  extractSummariesForCurrentPage,
  openDetailAndRead,
  downloadApiLogs,
  formatDateForInput,
  getDefaultApiLogDateRange,
  normalizeDateInput,
  isValidDateString,
  applyDateFilter,
  fromDateInputSelector,
  toDateInputSelector,
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
    it('parses details ID from onclick attribute with single quotes', () => {
      const id = parseDetailsId("openLogDetails('LOG-GUID-999')");
      assert.strictEqual(id, 'LOG-GUID-999');
    });

    it('parses details ID from onclick attribute with double quotes and trailing statement', () => {
      const id = parseDetailsId('openLogDetails("6aad52b93d3c0f565d011211"); return false;');
      assert.strictEqual(id, '6aad52b93d3c0f565d011211');
    });

    it('parses details ID with spaces and trailing statements', () => {
      const id = parseDetailsId('openLogDetails( "6aad52b93d3c0f565d011211" ) ; return false;');
      assert.strictEqual(id, '6aad52b93d3c0f565d011211');
    });

    it('parses unquoted details ID', () => {
      const id = parseDetailsId('openLogDetails(12345); return false;');
      assert.strictEqual(id, '12345');
    });

    it('parses details ID with javascript: prefix', () => {
      const id = parseDetailsId('javascript:openLogDetails("6aad52b93d3c0f565d011211");');
      assert.strictEqual(id, '6aad52b93d3c0f565d011211');
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
                <td><a onclick='openLogDetails("6aad52b93d3c0f565d011211"); return false;'>View</a></td>
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
        detailsId: '6aad52b93d3c0f565d011211',
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

  describe('openDetailAndRead', () => {
    it('reads detail form values from page', async () => {
      const mockDetailHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <input type="text" id="ctl00_tbUserName" value="alice.smith" />
            <input type="text" id="ctl00_tbMachineName" value="WEB-01" />
            <input type="text" id="ctl00_tbSupportId" value="SUP-1001" />
            <input type="text" id="ctl00_tbUserIp" value="192.168.1.10" />
            <a id="ctl00_hrefRequestUri" href="https://api.e-builder.net/v1/projects">URI</a>
            <input type="text" id="ctl00_tbRequestMethod" value="GET" />
            <textarea id="ctl00_tbRequestBody">{"test":true}</textarea>
            <input type="text" id="ctl00_tbRequestTime" value="2026-08-27 10:00:00" />
            <textarea id="ctl00_tbResponseBody">{"success":true}</textarea>
            <input type="text" id="ctl00_tbResponseTime" value="2026-08-27 10:00:01" />
            <input type="text" id="ctl00_tbResponseStatusCode" value="200" />
            <input type="text" id="ctl00_tbSuccess" value="True" />
            <button class="rwCloseButton">Close</button>
            <script>
              window.openLogDetails = function(id) {
                // in-page details already populated
              };
            </script>
          </body>
        </html>
      `;

      await page.setContent(mockDetailHtml);

      const detail = await openDetailAndRead(page, '6aad52b93d3c0f565d011211', 'SUP-1001');

      assert.strictEqual(detail.userName, 'alice.smith');
      assert.strictEqual(detail.machineName, 'WEB-01');
      assert.strictEqual(detail.supportId, 'SUP-1001');
      assert.strictEqual(detail.userIp, '192.168.1.10');
      assert.strictEqual(detail.requestUri, 'https://api.e-builder.net/v1/projects');
      assert.strictEqual(detail.requestMethod, 'GET');
      assert.strictEqual(detail.requestBody, '{"test":true}');
      assert.strictEqual(detail.requestTime, '2026-08-27 10:00:00');
      assert.strictEqual(detail.responseBody, '{"success":true}');
      assert.strictEqual(detail.responseTime, '2026-08-27 10:00:01');
      assert.strictEqual(detail.responseCode, '200');
      assert.strictEqual(detail.success, 'True');
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

  describe('Date Utilities for API logs', () => {
    it('formats dates as MM/DD/YYYY', () => {
      const d = new Date(2026, 8, 25);
      assert.strictEqual(formatDateForInput(d), '09/25/2026');
    });

    it('calculates default 30-day range correctly', () => {
      const refDate = new Date(2026, 8, 25);
      const range = getDefaultApiLogDateRange(refDate);
      assert.strictEqual(range.toDate, '09/25/2026');
      assert.strictEqual(range.fromDate, '08/26/2026');
    });

    it('normalizes YYYY-MM-DD and MM/DD/YYYY inputs to MM/DD/YYYY', () => {
      assert.strictEqual(normalizeDateInput('2026-08-01'), '08/01/2026');
      assert.strictEqual(normalizeDateInput('2026-8-5'), '08/05/2026');
      assert.strictEqual(normalizeDateInput('8/5/2026'), '08/05/2026');
      assert.strictEqual(normalizeDateInput('08/05/2026'), '08/05/2026');
    });

    it('validates date strings', () => {
      assert.strictEqual(isValidDateString('2026-08-01'), true);
      assert.strictEqual(isValidDateString('08/01/2026'), true);
      assert.strictEqual(isValidDateString('8/1/2026'), true);
      assert.strictEqual(isValidDateString('invalid'), false);
      assert.strictEqual(isValidDateString('13/01/2026'), false);
      assert.strictEqual(isValidDateString('02/30/2026'), false);
    });

    it('applies date filter values to DOM inputs and clicks filter button', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_fromDate_dateInput" value="" />
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_toDate_dateInput" value="" />
            <input type="submit" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnFilter" value="Filter" onclick="window.__filtered = true;" />
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      await applyDateFilter(page, '08/26/2026', '09/25/2026');

      const fromVal = await page.$eval(
        fromDateInputSelector,
        (el) => (el as HTMLInputElement).value,
      );
      const toVal = await page.$eval(toDateInputSelector, (el) => (el as HTMLInputElement).value);
      const wasFiltered = await page.evaluate(() => (window as any).__filtered);

      assert.strictEqual(fromVal, '08/26/2026');
      assert.strictEqual(toVal, '09/25/2026');
      assert.strictEqual(wasFiltered, true);
    });
  });
});
