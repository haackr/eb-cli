import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  fetchProjectBudgetItems,
  resolveBudgetItemIdentifiers,
  deleteBudgetItem,
  setBudgetItemProperties,
  clearBudgetItemCache,
  clearProjectCache,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('BudgetItem Operations (src/lib/eb-puppetmaster/budgetitem.ts)', () => {
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
    clearBudgetItemCache();
    clearProjectCache();
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  });

  describe('fetchProjectBudgetItems', () => {
    it('scrapes account codes and item IDs from cost summary grid', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <input type="checkbox" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_chkHideZeroValues" />
            <table id="ctl00_ctl00_ContentPlaceHolder1_contentSection_grdSummary_ctl00">
              <tr>
                <td><a onclick="LI('item-101')">01-100-200</a></td>
                <td><a onclick="LI('item-102')">02-200-300</a></td>
              </tr>
            </table>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);
      page.goto = async () => null as any;

      const itemMap = await fetchProjectBudgetItems(page, Environment.US1, 'proj-123');
      assert.strictEqual(itemMap.get('01-100-200'), 'item-101');
      assert.strictEqual(itemMap.get('02-200-300'), 'item-102');
    });
  });

  describe('resolveBudgetItemIdentifiers', () => {
    it('returns provided portalId and itemId directly without DOM queries', async () => {
      const result = await resolveBudgetItemIdentifiers({
        page,
        env: Environment.US1,
        portalId: 'P-123',
        itemId: 'I-456',
      });
      assert.deepStrictEqual(result, { portalId: 'P-123', itemId: 'I-456' });
    });

    it('throws error when neither portalId nor projectName is provided', async () => {
      await assert.rejects(
        async () =>
          resolveBudgetItemIdentifiers({
            page,
            env: Environment.US1,
            itemId: 'I-456',
          }),
        /Neither Project ID \(portalId\) nor Project Name was provided/,
      );
    });

    it('throws error when neither itemId nor accountCode is provided', async () => {
      await assert.rejects(
        async () =>
          resolveBudgetItemIdentifiers({
            page,
            env: Environment.US1,
            portalId: 'P-123',
          }),
        /Neither Item ID nor Account Code was provided/,
      );
    });

    it('resolves itemId from accountCode using cost summary table', async () => {
      const mockHtml = `
        <html>
          <body>
            <table id="ctl00_ctl00_ContentPlaceHolder1_contentSection_grdSummary_ctl00">
              <tr>
                <td><a onclick="LI('item-999')">05-500-000</a></td>
              </tr>
            </table>
          </body>
        </html>
      `;
      await page.setContent(mockHtml);
      page.goto = async () => null as any;

      const result = await resolveBudgetItemIdentifiers({
        page,
        env: Environment.US1,
        portalId: 'P-123',
        accountCode: '05-500-000',
      });

      assert.deepStrictEqual(result, { portalId: 'P-123', itemId: 'item-999' });
    });
  });

  describe('deleteBudgetItem', () => {
    it('clicks delete and confirm buttons on line item details page', async () => {
      const mockHtml = `
        <html>
          <body>
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete">Delete</button>
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete" style="display:none">Confirm</button>
            <script>
              document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete').onclick = () => {
                document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete').style.display = 'block';
              };
              document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete').onclick = () => {
                window.__deleted = true;
              };
            </script>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);
      page.goto = async () => null as any;
      page.waitForNavigation = async () => null as any;
      page.close = async () => {};

      await deleteBudgetItem({
        env: Environment.US1,
        cookies: [],
        browser,
        page,
        budgetItem: {
          budgetItemId: 'I-1',
          projectId: 'P-1',
        },
        dryRun: false,
      });

      const wasDeleted = await page.evaluate(() => (window as any).__deleted);
      assert.strictEqual(wasDeleted, true);
    });

    it('skips clicking confirm button when dryRun is true', async () => {
      const mockHtml = `
        <html>
          <body>
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete">Delete</button>
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete" style="display:none">Confirm</button>
            <script>
              document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnDelete').onclick = () => {
                document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete').style.display = 'block';
              };
              document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYesDelete').onclick = () => {
                window.__deleted = true;
              };
            </script>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);
      page.goto = async () => null as any;
      page.waitForNavigation = async () => null as any;
      page.close = async () => {};

      await deleteBudgetItem({
        env: Environment.US1,
        cookies: [],
        browser,
        page,
        budgetItem: {
          budgetItemId: 'I-1',
          projectId: 'P-1',
        },
        dryRun: true,
      });

      const wasDeleted = await page.evaluate(() => (window as any).__deleted);
      assert.strictEqual(wasDeleted, undefined);
    });
  });

  describe('setBudgetItemProperties', () => {
    it('toggles checkboxes, fills description, and saves', async () => {
      const mockHtml = `
        <html>
          <body>
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnEditDetails">Edit</button>
            <input type="checkbox" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAllowCharges" />
            <input type="checkbox" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAppReq" />
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_tbDescription" value="" />
            <button id="ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSave">Save</button>
            <script>
              document.getElementById('ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSave').onclick = () => {
                window.__saved = true;
              };
            </script>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);
      page.goto = async () => null as any;
      page.waitForNavigation = async () => null as any;
      page.close = async () => {};

      await setBudgetItemProperties({
        env: Environment.US1,
        cookies: [],
        browser,
        page,
        budgetItem: {
          budgetItemId: 'I-1',
          projectId: 'P-1',
          allowCharges: true,
          approvalRequiredForChange: true,
          description: 'Updated Budget Description',
        },
        dryRun: false,
      });

      const state = await page.evaluate(() => ({
        allowCharges: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAllowCharges',
          ) as HTMLInputElement
        ).checked,
        appReq: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_chkAppReq',
          ) as HTMLInputElement
        ).checked,
        desc: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_tbDescription',
          ) as HTMLInputElement
        ).value,
        saved: (window as any).__saved,
      }));

      assert.strictEqual(state.allowCharges, true);
      assert.strictEqual(state.appReq, true);
      assert.strictEqual(state.desc, 'Updated Budget Description');
      assert.strictEqual(state.saved, true);
    });
  });
});
