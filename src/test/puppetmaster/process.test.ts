import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { chromium, type Browser, type Page } from 'playwright';
import {
  buildProcessInstanceUrl,
  clearFieldsByNames,
  findFieldsStillPopulated,
  isAuthenticatedProcessPage,
  setProcessInstanceFieldsToNull,
  Environment,
  BrowserManager,
} from '../../lib/eb-puppetmaster/index.js';

describe('Process Operations (src/lib/eb-puppetmaster/process.ts)', () => {
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

  describe('buildProcessInstanceUrl', () => {
    it('replaces {env} and {id} placeholders', () => {
      const template = 'https://{env}.e-builder.net/instancedetails.aspx?instanceid={id}&AF=1';
      const url = buildProcessInstanceUrl(template, Environment.US1, 'PROC-12345');
      assert.strictEqual(
        url,
        'https://app.e-builder.net/instancedetails.aspx?instanceid=PROC-12345&AF=1',
      );
    });
  });

  describe('clearFieldsByNames and findFieldsStillPopulated', () => {
    it('clears inputs, textareas, selects, checkboxes, and radio buttons', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Process Details</title></head>
          <body>
            <div id="ctl00_contentSection_dataFields">
              <table>
                <tr>
                  <td class="Label">PO Number:</td>
                  <td class="Details"><input type="text" id="txtPoNum" value="PO-9999" /></td>
                </tr>
                <tr>
                  <td class="Label">Scope Notes:</td>
                  <td class="Details"><textarea id="txtNotes">Some scope description</textarea></td>
                </tr>
                <tr>
                  <td class="Label">Priority:</td>
                  <td class="Details">
                    <select id="selPriority">
                      <option value="">-- Select --</option>
                      <option value="LOW">Low</option>
                      <option value="HIGH" selected>High</option>
                    </select>
                  </td>
                </tr>
                <tr>
                  <td class="Label">Is Expedited:</td>
                  <td class="Details"><input type="checkbox" id="chkExpedited" checked /></td>
                </tr>
                <tr>
                  <td class="Label">Status Choice:</td>
                  <td class="Details">
                    <input type="radio" name="radStatus" id="radStatusActive" checked />
                    <input type="radio" name="radStatus" id="radStatusPending" />
                  </td>
                </tr>
              </table>
            </div>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const isAuthed = await isAuthenticatedProcessPage(page);
      assert.strictEqual(isAuthed, true);

      const result = await clearFieldsByNames(page, [
        'PO Number',
        'Scope Notes',
        'Priority',
        'Is Expedited',
        'Status Choice',
        'NonExistent',
      ]);

      assert.ok(result.clearedFields.includes('PO Number'));
      assert.ok(result.clearedFields.includes('Scope Notes'));
      assert.ok(result.clearedFields.includes('Priority'));
      assert.ok(result.clearedFields.includes('Is Expedited'));
      assert.ok(result.clearedFields.includes('Status Choice'));
      assert.ok(result.notFoundFields.includes('NonExistent'));

      const stillPopulated = await findFieldsStillPopulated(page, result.clearedFields);
      assert.deepStrictEqual(stillPopulated, []);

      const formState = await page.evaluate(() => ({
        po: (document.getElementById('txtPoNum') as HTMLInputElement).value,
        notes: (document.getElementById('txtNotes') as HTMLTextAreaElement).value,
        priority: (document.getElementById('selPriority') as HTMLSelectElement).value,
        expedited: (document.getElementById('chkExpedited') as HTMLInputElement).checked,
        radioChecked: (document.getElementById('radStatusActive') as HTMLInputElement).checked,
      }));

      assert.strictEqual(formState.po, '');
      assert.strictEqual(formState.notes, '');
      assert.strictEqual(formState.priority, '');
      assert.strictEqual(formState.expedited, false);
      assert.strictEqual(formState.radioChecked, false);
    });

    it('handles Telerik RadComboBox and RadDatePicker controls', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <div id="ctl00_contentSection_dataFields">
              <table>
                <tr>
                  <td class="Label">Vendor Dropdown</td>
                  <td class="Details">
                    <div class="RadComboBox">
                      <input type="text" id="rcbVendor_Input" value="Acme Supplies" />
                      <input type="hidden" id="rcbVendor_Value" value="ACME_1" />
                      <input type="hidden" id="rcbVendor_ClientState" value='{"value":"ACME_1","text":"Acme Supplies"}' />
                    </div>
                  </td>
                </tr>
                <tr>
                  <td class="Label">Target Delivery Date</td>
                  <td class="Details">
                    <div class="RadPicker">
                      <input type="text" id="rdpDate_dateInput" value="2026-09-01" />
                      <input type="hidden" id="rdpDate_Value" value="2026-09-01" />
                    </div>
                  </td>
                </tr>
              </table>
            </div>
          </body>
        </html>
      `;

      await page.setContent(mockHtml);

      const result = await clearFieldsByNames(page, ['Vendor Dropdown', 'Target Delivery Date']);
      assert.ok(result.clearedFields.includes('Vendor Dropdown'));
      assert.ok(result.clearedFields.includes('Target Delivery Date'));

      const telerikState = await page.evaluate(() => ({
        vendorInput: (document.getElementById('rcbVendor_Input') as HTMLInputElement).value,
        vendorValue: (document.getElementById('rcbVendor_Value') as HTMLInputElement).value,
        dateInput: (document.getElementById('rdpDate_dateInput') as HTMLInputElement).value,
      }));

      assert.strictEqual(telerikState.vendorInput, '');
      assert.strictEqual(telerikState.vendorValue, '');
      assert.strictEqual(telerikState.dateInput, '');
    });
  });

  describe('setProcessInstanceFieldsToNull validation', () => {
    it('throws error if fieldNames array is empty', async () => {
      await assert.rejects(
        async () =>
          setProcessInstanceFieldsToNull({
            env: Environment.US1,
            cookies: [],
            processInstanceId: 'PROC-1',
            fieldNames: [],
          }),
        /At least one field name is required/,
      );
    });
  });
});
