import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import { selectUsersInProjectGrid, BrowserManager } from '../../lib/eb-puppetmaster/index.js';

describe('Remove User from Project (src/lib/eb-puppetmaster/remove-project.ts)', () => {
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

  it('selects matching user checkboxes in project participants table', async () => {
    const tableHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <table id="grdResults">
            <tr class="RowData">
              <td><input type="checkbox" id="chk1" /></td>
              <td>Jane Doe</td>
              <td>jane.doe</td>
            </tr>
            <tr class="AltRowData">
              <td><input type="checkbox" id="chk2" /></td>
              <td>John Smith</td>
              <td>john.smith</td>
            </tr>
          </table>
        </body>
      </html>
    `;

    await page.setContent(tableHtml);

    const matched = await selectUsersInProjectGrid(page, ['jane.doe', 'nonexistent.user']);

    assert.deepStrictEqual(matched, ['jane.doe']);

    const isChk1Checked = await page.evaluate(
      () => (document.getElementById('chk1') as HTMLInputElement).checked,
    );
    const isChk2Checked = await page.evaluate(
      () => (document.getElementById('chk2') as HTMLInputElement).checked,
    );

    assert.strictEqual(isChk1Checked, true);
    assert.strictEqual(isChk2Checked, false);
  });
});
