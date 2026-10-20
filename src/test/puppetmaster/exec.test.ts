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
  });
});
