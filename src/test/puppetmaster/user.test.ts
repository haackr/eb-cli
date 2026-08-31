import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { chromium, type Browser, type Page } from 'playwright';
import {
  setUserFieldsOnPage,
  setSsoField,
  getUserSsoStatus,
  listManagedUsers,
  deleteUser,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('User Operations (src/lib/eb-puppetmaster/user.ts)', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({
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

  describe('setUserFieldsOnPage', () => {
    it('updates built-in and custom fields on user edit page', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_iptFirstName" value="OldFirst" />
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_iptLastName" value="OldLast" />
            <input type="text" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_iptCompany" value="OldCo" />
            <input type="checkbox" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_chkHideFromGlobal" />
            
            <input type="radio" name="auth" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO" />
            <input type="radio" name="auth" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone" checked />

            <div id="ctl00_ctl00_ContentPlaceHolder1_contentSection_pvCustomFields">
              <table>
                <tr>
                  <td class="Label">Cost Center</td>
                  <td class="Details"><input type="text" value="OldCostCenter" /></td>
                </tr>
                <tr>
                  <td class="Label">Department Code</td>
                  <td class="Details">
                    <select>
                      <option value="ENG">Engineering</option>
                      <option value="FIN">Finance</option>
                    </select>
                  </td>
                </tr>
              </table>
            </div>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const result = await setUserFieldsOnPage(page, {
        'First Name': 'Jane',
        Company: 'Acme Corp',
        'Hide in Global Directory': 'true',
        'Login Authentication': 'Require Single Sign-On',
        'Cost Center': 'CC-900',
        'Department Code': 'Finance',
        NonExistentField: 'SomeValue',
      });

      assert.ok(result.updatedFields.includes('First Name'));
      assert.ok(result.updatedFields.includes('Company'));
      assert.ok(result.updatedFields.includes('Hide in Global Directory'));
      assert.ok(result.updatedFields.includes('Cost Center'));
      assert.ok(result.updatedFields.includes('Department Code'));
      assert.ok(result.notFoundFields.includes('NonExistentField'));

      const domValues = await page.evaluate(() => ({
        firstName: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_iptFirstName',
          ) as HTMLInputElement
        ).value,
        company: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_iptCompany',
          ) as HTMLInputElement
        ).value,
        hideGlobal: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_chkHideFromGlobal',
          ) as HTMLInputElement
        ).checked,
        ssoChecked: (
          document.getElementById(
            'ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          ) as HTMLInputElement
        ).checked,
        customCostCenter: (
          document.querySelector(
            '#ctl00_ctl00_ContentPlaceHolder1_contentSection_pvCustomFields input',
          ) as HTMLInputElement
        ).value,
        customDept: (
          document.querySelector(
            '#ctl00_ctl00_ContentPlaceHolder1_contentSection_pvCustomFields select',
          ) as HTMLSelectElement
        ).value,
      }));

      assert.strictEqual(domValues.firstName, 'Jane');
      assert.strictEqual(domValues.company, 'Acme Corp');
      assert.strictEqual(domValues.hideGlobal, true);
      assert.strictEqual(domValues.ssoChecked, true);
      assert.strictEqual(domValues.customCostCenter, 'CC-900');
      assert.strictEqual(domValues.customDept, 'FIN');
    });
  });

  describe('setSsoField', () => {
    it('sets SSO radio button to enabled and disabled', async () => {
      const mockHtml = `
        <html>
          <body>
            <div id="ctl00_ctl00_ContentPlaceHolder1_contentSection_trLoginAndContact">
              <input type="radio" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO" name="sso" />
              <input type="radio" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone" name="sso" checked />
            </div>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      await setSsoField(page, true);
      let isSsoChecked = await page.evaluate(
        () =>
          (
            document.getElementById(
              'ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
            ) as HTMLInputElement
          ).checked,
      );
      assert.strictEqual(isSsoChecked, true);

      await setSsoField(page, false);
      let isNoneChecked = await page.evaluate(
        () =>
          (
            document.getElementById(
              'ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
            ) as HTMLInputElement
          ).checked,
      );
      assert.strictEqual(isNoneChecked, true);
    });
  });

  describe('getUserSsoStatus', () => {
    it('extracts SSO status from user view page', async () => {
      const mockHtml = `
        <html>
          <body>
            <span id="ctl00_ctl00_ContentPlaceHolder1_contentSection_lblLogin">Require Single Sign-On</span>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const mockBrowser: any = {
        isConnected: () => true,
        contexts: () => [
          {
            addCookies: async () => {},
            newPage: async () => {
              page.goto = async () => null as any;
              return page;
            },
          },
        ],
        newContext: async () => ({
          addCookies: async () => {},
          newPage: async () => {
            page.goto = async () => null as any;
            return page;
          },
        }),
      };

      const status = await getUserSsoStatus({
        env: Environment.US1,
        cookies: [],
        browser: mockBrowser,
        userId: 'U-888',
      });

      assert.strictEqual(status.userId, 'U-888');
      assert.strictEqual(status.loginAuthentication, 'Require Single Sign-On');
      assert.strictEqual(status.ssoRequired, true);
    });
  });

  describe('listManagedUsers', () => {
    it('scrapes user rows from manage users grid', async () => {
      const mockHtml = `
        <html>
          <body>
            <table id="ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults">
              <tr class="RowData">
                <td><input type="checkbox" data-userid="1001" data-name="Alice Admin" /></td>
                <td><a id="grid_ctl02_UserName" href="ViewUser.aspx?UserID=1001">Alice Admin</a></td>
                <td>Active</td>
                <td>alice.admin</td>
                <td>Acme Construction</td>
              </tr>
              <tr class="AltRowData">
                <td><input type="checkbox" data-userid="1002" data-name="Bob Builder" /></td>
                <td><a id="grid_ctl03_UserName" href="ViewUser.aspx?UserID=1002">Bob Builder</a></td>
                <td>Active</td>
                <td>bob.builder</td>
                <td>Build Corp</td>
              </tr>
            </table>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const mockBrowser: any = {
        isConnected: () => true,
        contexts: () => [
          {
            addCookies: async () => {},
            newPage: async () => {
              page.goto = async () => null as any;
              return page;
            },
          },
        ],
        newContext: async () => ({
          addCookies: async () => {},
          newPage: async () => {
            page.goto = async () => null as any;
            return page;
          },
        }),
      };

      const users = await listManagedUsers({
        env: Environment.US1,
        cookies: [],
        browser: mockBrowser,
      });

      assert.strictEqual(users.length, 2);
      assert.strictEqual(users[0]?.userId, '1001');
      assert.strictEqual(users[0]?.name, 'Alice Admin');
      assert.strictEqual(users[0]?.userName, 'alice.admin');
      assert.strictEqual(users[0]?.companyName, 'Acme Construction');

      assert.strictEqual(users[1]?.userId, '1002');
      assert.strictEqual(users[1]?.userName, 'bob.builder');
    });
  });

  describe('deleteUser validation', () => {
    it('throws error when user.userName is missing', async () => {
      await assert.rejects(
        async () =>
          deleteUser({
            env: Environment.US1,
            cookies: [],
            user: {} as any,
            dryRun: false,
          }),
        /Missing userName/,
      );
    });
  });
});
