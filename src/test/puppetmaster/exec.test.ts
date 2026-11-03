import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import {
  resolveSessionUrl,
  executeInSession,
  normalizeUserScript,
  looksLikePuppeteerScript,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

const require_sep = () => (process.platform === 'win32' ? '\\' : '/');

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

    const page = (title: string, body: string) =>
      'data:text/html,' +
      encodeURIComponent(
        `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`,
      );

    it('runs module-style script files (export default / module.exports) in both modes', async () => {
      const url = page('Modules', '<span id="v">42</span>');
      const dom = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        script: `export default (arg) => document.getElementById('v').textContent + arg;`,
        arg: '!',
      });
      assert.strictEqual(dom.result, '42!');

      const pptr = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        mode: 'puppeteer',
        script: `const sel = '#v';\nmodule.exports = async ({ page, args }) => {\n  const t = await page.$eval(sel, (el) => el.textContent);\n  return t + args.s;\n};\n`,
        arg: { s: '?' },
      });
      assert.strictEqual(pptr.result, '42?');
    });

    it('passes the page directly to `async (page) => ...` scripts and exposes fs/path/os/eb', async () => {
      const url = page(
        'Ctx',
        '<table id="grid"><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
      );
      const bare = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        mode: 'puppeteer',
        script: `async (page) => await page.title()`,
      });
      assert.strictEqual(bare.result, 'Ctx');

      const ctx = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        mode: 'puppeteer',
        script: `async ({ fs, path, os, eb }) => ({
          hasFs: typeof fs.readFileSync === 'function',
          sep: path.sep,
          hasOs: typeof os.tmpdir === 'function',
          table: await eb.getTable('#grid'),
        })`,
      });
      assert.deepStrictEqual(ctx.result, {
        hasFs: true,
        sep: require_sep(),
        hasOs: true,
        table: { headers: ['A'], rowCount: 1, rows: [{ A: '1' }] },
      });
    });

    it('applies --dialog-policy and records dialogs', async () => {
      const url = page('Dialogs', '');
      const dismissed = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        script: `() => confirm('Delete line item?')`,
      });
      assert.strictEqual(dismissed.result, false);
      assert.deepStrictEqual(dismissed.dialogs, [
        { type: 'confirm', message: 'Delete line item?', defaultValue: '', handled: 'dismissed' },
      ]);

      const accepted = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        dialogPolicy: 'accept',
        script: `() => confirm('Void instance?')`,
      });
      assert.strictEqual(accepted.result, true);
      assert.strictEqual(accepted.dialogs[0]?.handled, 'accepted');
    });

    it('yields to a dialog listener registered by a Puppeteer script', async () => {
      const result = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url: page('Prompt', ''),
        mode: 'puppeteer',
        script: `async ({ page }) => {
          page.on('dialog', (d) => d.accept('from-script'));
          return await page.evaluate(() => prompt('Name?'));
        }`,
      });
      assert.strictEqual(result.result, 'from-script');
      assert.strictEqual(result.dialogs[0]?.handled, 'script');
    });

    it('uses first-row <td> headers for e-Builder TableGrid tables', async () => {
      const url = page(
        'Grid',
        '<table id="grdProcesses" class="TableGrid"><tr><td><a>Name</a></td><td><a>Prefix</a></td></tr><tr><td>Invoice</td><td>INV</td></tr></table>',
      );
      const result = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        inspect: true,
        script: `(arg, eb) => eb.getTable('#grdProcesses')`,
      });
      assert.deepStrictEqual(result.result, {
        headers: ['Name', 'Prefix'],
        rowCount: 1,
        rows: [{ Name: 'Invoice', Prefix: 'INV' }],
      });
      const grid = result.inspection?.tables.find((t) => t.id === 'grdProcesses');
      assert.deepStrictEqual(grid?.headers, ['Name', 'Prefix']);
      assert.strictEqual(grid?.rowCount, 1);
    });

    it('ignores hidden about:blank iframes when locating the content document', async () => {
      const url = page(
        'Inner Page',
        '<iframe src="about:blank" style="display:none"></iframe><label for="f">Field</label><input id="f" name="f" value="x"/>',
      );
      const result = await executeInSession({
        env: Environment.US1,
        cookies: [],
        browser,
        url,
        inspect: true,
        script: `(arg, eb) => eb.getContentDocument() === document`,
      });
      assert.strictEqual(result.result, true);
      assert.strictEqual(result.frameUrl, null);
      assert.strictEqual(result.inspection?.frameUrl, null);
      assert.ok(result.inspection?.fields.some((f) => f.name === 'f'));
    });
  });

  describe('normalizeUserScript / looksLikePuppeteerScript', () => {
    it('strips leading export wrappers and trailing semicolons', () => {
      assert.strictEqual(
        normalizeUserScript('export default async ({ page }) => 1;'),
        'async ({ page }) => 1',
      );
      assert.strictEqual(normalizeUserScript('module.exports = (a) => a;\n'), '(a) => a');
      assert.strictEqual(normalizeUserScript('exports.default = () => 2'), '() => 2');
      assert.strictEqual(normalizeUserScript('document.title'), 'document.title');
    });

    it('wraps files with helpers before the export in an IIFE', () => {
      const code = normalizeUserScript('const x = 1;\nmodule.exports = () => x;');
      assert.strictEqual((0, eval)(`(${code})`)(), 1);
    });

    it('detects Puppeteer-style scripts', () => {
      for (const code of [
        'async ({ page, arg }) => {}',
        'async ({ arg, page }) => {}',
        'export default async function run({ browser }) {}',
        'async (page) => page.title()',
        'page => page.title()',
        'await page.goto("/da2/Home/index2.aspx")',
        'async ({ eb }) => eb.getWorkflowData(pid, wid)',
        'async ({ fs, arg }) => fs.readFileSync(arg)',
      ]) {
        assert.strictEqual(looksLikePuppeteerScript(code), true, code);
      }
      for (const code of [
        'document.title',
        '(arg, eb) => eb.findField("Title")?.value',
        '() => [...document.querySelectorAll("a")].length',
      ]) {
        assert.strictEqual(looksLikePuppeteerScript(code), false, code);
      }
    });
  });
});
