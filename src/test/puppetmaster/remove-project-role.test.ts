import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  selectMatchingUsersOnCurrentPage,
  findRemoveButton,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('Remove User from Project Role (src/lib/eb-puppetmaster/remove-project-role.ts)', () => {
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

  it('selects matching users by email, username, inverted name, and id', async () => {
    const userGridHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <table id="grdResults">
            <tr class="RowData">
              <td><input type="checkbox" id="u1" data-username="alice.manager" /></td>
              <td>Alice Manager</td>
              <td>alice.manager@company.com</td>
            </tr>
            <tr class="AltRowData">
              <td><input type="checkbox" id="u2" data-name="Smith, Bob" /></td>
              <td>Bob Smith</td>
              <td>bob.smith@company.com</td>
            </tr>
          </table>
          <button id="btnRoleRemove">Remove</button>
        </body>
      </html>
    `;

    await page.setContent(userGridHtml);

    const matched = await selectMatchingUsersOnCurrentPage(page, [
      'alice.manager',
      'Bob Smith',
      'missing.user@company.com',
    ]);

    assert.ok(matched.includes('alice.manager'));
    assert.ok(matched.includes('bob smith'));
    assert.strictEqual(matched.length, 2);

    const checkStates = await page.evaluate(() => ({
      u1: (document.getElementById('u1') as HTMLInputElement).checked,
      u2: (document.getElementById('u2') as HTMLInputElement).checked,
    }));

    assert.strictEqual(checkStates.u1, true);
    assert.strictEqual(checkStates.u2, true);

    const removeBtn = await findRemoveButton(page);
    assert.ok(removeBtn);
  });
});
