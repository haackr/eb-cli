import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  resolveSessionUrl,
  executeInSession,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('Session Exec Operations (src/lib/eb-puppetmaster/exec.ts)', () => {
  let browser: puppeteer.Browser;

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

  describe('resolveSessionUrl', () => {
    it('defaults to Home page for the given environment when path is omitted', () => {
      assert.strictEqual(
        resolveSessionUrl(Environment.US1),
        'https://app.e-builder.net/da2/Home/index2.aspx',
      );
      assert.strictEqual(
        resolveSessionUrl(Environment.US2, '   '),
        'https://app-us2.e-builder.net/da2/Home/index2.aspx',
      );
    });

    it('resolves relative paths with or without leading slash', () => {
      assert.strictEqual(
        resolveSessionUrl(Environment.US1, '/da2/Processes/ProcessesView.aspx'),
        'https://app.e-builder.net/da2/Processes/ProcessesView.aspx',
      );
      assert.strictEqual(
        resolveSessionUrl(Environment.CA, 'da2/Setup/Processes/ProcessTypesView.aspx'),
        'https://app.ca.e-builder.net/da2/Setup/Processes/ProcessTypesView.aspx',
      );
    });

    it('rewrites mismatched e-Builder environment hostnames to match the session environment', () => {
      assert.strictEqual(
        resolveSessionUrl(
          Environment.US1,
          'https://app-us2.e-builder.net/da2/Processes/StartProcess.aspx?ProjectID=123',
        ),
        'https://app.e-builder.net/da2/Processes/StartProcess.aspx?ProjectID=123',
      );
      assert.strictEqual(
        resolveSessionUrl(Environment.US2, 'https://app.e-builder.ca/da2/Home/index2.aspx#top'),
        'https://app-us2.e-builder.net/da2/Home/index2.aspx#top',
      );
    });
  });

  describe('executeInSession', () => {
    it('evaluates DOM expressions, IIFEs, and functions with arguments', async () => {
      const dataUrl =
        'data:text/html,' +
        encodeURIComponent(
          '<!DOCTYPE html><html><head><title>Test Admin Page</title></head><body><input type="hidden" id="test_hCustomFields" value=\'[{"Name":"Fund","DataType":"DropDown"}]\'/></body></html>',
        );

      const iifeResult = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url: dataUrl,
        script: `(() => {
          const raw = document.querySelector('input[id$="_hCustomFields"]')?.value;
          return raw ? JSON.parse(raw) : [];
        })()`,
      });

      assert.strictEqual(iifeResult.title, 'Test Admin Page');
      assert.deepStrictEqual(iifeResult.result, [{ Name: 'Fund', DataType: 'DropDown' }]);

      const fnResult = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url: dataUrl,
        script: `(arg) => ({ title: document.title, multiplier: arg.count * 2 })`,
        arg: { count: 21 },
      });

      assert.deepStrictEqual(fnResult.result, {
        title: 'Test Admin Page',
        multiplier: 42,
      });
    });

    it('executes Puppeteer mode scripts with full page context', async () => {
      const dataUrl =
        'data:text/html,' +
        encodeURIComponent(
          '<!DOCTYPE html><html><head><title>Puppeteer Mode</title></head><body><button id="btn" onclick="document.body.dataset.clicked=\'yes\'">Click Me</button></body></html>',
        );

      const result = await executeInSession({
        env: Environment.US2,
        cookies: [],
        browser,
        url: dataUrl,
        mode: 'puppeteer',
        arg: { suffix: 'ok' },
        script: `async ({ page, origin, arg }) => {
          await page.click('#btn');
          const clicked = await page.evaluate(() => document.body.dataset.clicked);
          return { origin, clicked, suffix: arg.suffix };
        }`,
      });

      assert.deepStrictEqual(result.result, {
        origin: 'https://app-us2.e-builder.net',
        clicked: 'yes',
        suffix: 'ok',
      });
    });

    it('inspects page controls, forms, RadComboBoxes, and tables with inspect: true', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Process Start</title></head>
          <body>
            <div class="breadcrumb"><span>Processes</span> &gt; <span>Start</span></div>
            <div class="errorMessage">Please correct errors below.</div>
            <form action="post.aspx">
              <label for="tbProject">Project Name *</label>
              <input type="text" id="tbProject" name="ProjectName" value="Capital Project Alpha" required />

              <label for="taDesc">Description</label>
              <textarea id="taDesc" name="Desc">Sample description</textarea>

              <label for="selType">Type</label>
              <select id="selType" name="Type">
                <option value="1" selected>Type 1</option>
                <option value="2">Type 2</option>
              </select>

              <div id="ctl00_rcbVendor" class="RadComboBox">
                <label for="ctl00_rcbVendor">Vendor</label>
                <input class="rcbInput" value="Acme Corp" />
                <input type="hidden" id="ctl00_rcbVendor_Value" name="ctl00_rcbVendor_Value" value="V-100" />
              </div>
              <div id="ctl00_rcbVendor_DropDown">
                <ul>
                  <li class="rcbItem" data-value="V-100">Acme Corp</li>
                  <li class="rcbItem" data-value="V-200">Beta LLC</li>
                </ul>
              </div>

              <input type="submit" id="btnSubmit" value="Submit Form" />
            </form>

            <table id="itemsGrid" class="rgMasterTable">
              <thead>
                <tr><th>Item ID</th><th>Cost</th></tr>
              </thead>
              <tbody>
                <tr><td>ITEM-1</td><td>$100.00</td></tr>
                <tr><td>ITEM-2</td><td>$250.00</td></tr>
              </tbody>
            </table>
          </body>
        </html>
      `;

      const dataUrl = 'data:text/html,' + encodeURIComponent(mockHtml);

      const inspectResult = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url: dataUrl,
        inspect: true,
      });

      assert.ok(inspectResult.inspection);
      const insp = inspectResult.inspection;

      assert.strictEqual(insp.title, 'Process Start');
      assert.deepStrictEqual(insp.alerts, ['Please correct errors below.']);
      assert.ok(insp.breadcrumbs.length > 0);

      // Check fields
      const projectField = insp.fields.find((f) => f.name === 'ProjectName');
      assert.ok(projectField);
      assert.strictEqual(projectField?.value, 'Capital Project Alpha');
      assert.strictEqual(projectField?.required, true);

      const vendorField = insp.fields.find((f) => f.id === 'ctl00_rcbVendor');
      assert.ok(vendorField);
      assert.strictEqual(vendorField?.type, 'radcombobox');
      assert.strictEqual(vendorField?.value, 'V-100');
      assert.strictEqual(vendorField?.options?.length, 2);

      // Check actions
      const submitAction = insp.actions.find((a) => a.id === 'btnSubmit');
      assert.ok(submitAction);
      assert.strictEqual(submitAction?.text, 'Submit Form');

      // Check tables
      assert.strictEqual(insp.tables.length, 1);
      assert.deepStrictEqual(insp.tables[0]?.headers, ['Item ID', 'Cost']);
      assert.strictEqual(insp.tables[0]?.rowCount, 2);
      assert.deepStrictEqual(insp.tables[0]?.sampleRows[0], {
        'Item ID': 'ITEM-1',
        Cost: '$100.00',
      });
    });

    it('injects in-browser eb helper enabling concise DOM navigation and control queries', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Helper Test</title></head>
          <body>
            <label for="ctl00_ctl00_tbTitle">Title</label>
            <input type="text" id="ctl00_ctl00_tbTitle" value="Helper Works" />
            <table id="testTable">
              <thead><tr><th>A</th><th>B</th></tr></thead>
              <tbody><tr><td>1</td><td>2</td></tr></tbody>
            </table>
          </body>
        </html>
      `;
      const dataUrl = 'data:text/html,' + encodeURIComponent(mockHtml);

      const result = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url: dataUrl,
        script: `(arg, eb) => {
          const field = eb.findField('Title');
          const table = eb.getTable('#testTable');
          return {
            fieldVal: field ? field.value : null,
            tableData: table
          };
        }`,
      });

      assert.deepStrictEqual(result.result, {
        fieldVal: 'Helper Works',
        tableData: {
          headers: ['A', 'B'],
          rowCount: 1,
          rows: [{ A: '1', B: '2' }],
        },
      });
    });

    it('captures failure diagnostics with ExecuteInSessionError', async () => {
      const dataUrl =
        'data:text/html,' +
        encodeURIComponent(
          '<!DOCTYPE html><html><head><title>Error Page</title></head><body>Fail</body></html>',
        );

      await assert.rejects(
        async () => {
          await executeInSession({
            env: Environment.US1,
            cookies: [],
            browser,
            url: dataUrl,
            script: `() => { throw new Error('Simulated DOM failure'); }`,
            screenshotOnFailure: true,
          });
        },
        (err: any) => {
          assert.strictEqual(err.name, 'ExecuteInSessionError');
          assert.match(err.message, /Simulated DOM failure/);
          assert.strictEqual(err.title, 'Error Page');
          assert.ok(err.screenshotPath);
          return true;
        },
      );
    });
  });
});
