import * as path from 'path';
import * as os from 'os';
import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';

export type ExecuteInSessionMode = 'dom' | 'puppeteer';

export interface PageInspectionField {
  id?: string | undefined;
  name?: string | undefined;
  type: string;
  label?: string | undefined;
  value?: string | boolean | null | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  options?: Array<{ value: string; text: string; selected?: boolean | undefined }> | undefined;
}

export interface PageInspectionTable {
  id?: string | undefined;
  headers: string[];
  rowCount: number;
  sampleRows: Record<string, string>[];
}

export interface PageInspectionAction {
  id?: string | undefined;
  text: string;
  type: string;
  disabled?: boolean | undefined;
}

export interface PageInspectionResult {
  title: string;
  url: string;
  frameUrl?: string | null | undefined;
  breadcrumbs: string[];
  activeTab?: string | null | undefined;
  fields: PageInspectionField[];
  actions: PageInspectionAction[];
  tables: PageInspectionTable[];
  alerts: string[];
}

export class ExecuteInSessionError extends Error {
  public url?: string | undefined;
  public title?: string | undefined;
  public frameUrl?: string | null | undefined;
  public screenshotPath?: string | null | undefined;

  constructor(
    message: string,
    details?: {
      url?: string | undefined;
      title?: string | undefined;
      frameUrl?: string | null | undefined;
      screenshotPath?: string | null | undefined;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ExecuteInSessionError';
    if (details) {
      this.url = details.url;
      this.title = details.title;
      this.frameUrl = details.frameUrl;
      this.screenshotPath = details.screenshotPath;
      if (details.cause) this.cause = details.cause;
    }
  }
}

export type ExecuteInSessionOptions = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  headless?: boolean | undefined;
  url?: string | undefined;
  waitForSelector?: string | undefined;
  script?: string | undefined;
  mode?: ExecuteInSessionMode | undefined;
  arg?: unknown;
  screenshotPath?: string | undefined;
  screenshotOnFailure?: boolean | undefined;
  inspect?: boolean | undefined;
  blockAssets?: boolean | undefined;
};

export type ExecuteInSessionResult = {
  url: string;
  title: string;
  frameUrl: string | null;
  result: unknown;
  inspection?: PageInspectionResult | undefined;
  cookies: puppeteer.Cookie[];
  screenshotPath: string | null;
};

export type PuppeteerExecContext = {
  page: puppeteer.Page;
  browser: puppeteer.Browser;
  context: puppeteer.BrowserContext;
  env: Environment;
  origin: string;
  url: string;
  arg: unknown;
  settle: () => Promise<void>;
  inspect: () => Promise<PageInspectionResult>;
};

const EBUILDER_HOST_PATTERN = /(^|\.)e-builder\.(net|ca)$/i;

/**
 * Resolves a relative path or full URL to the active e-Builder session's environment origin.
 * If a full e-Builder URL is provided with a different environment subdomain (e.g., app-us2 vs app),
 * it is rewritten to the session's authenticated environment origin to prevent accidental logouts.
 */
export function resolveSessionUrl(env: Environment, pathOrUrl?: string): string {
  const origin = `https://${env}.${baseurl}`;
  const trimmed = pathOrUrl?.trim();

  if (!trimmed) {
    return `${origin}/da2/Home/index2.aspx`;
  }

  if (/^(data|about|file):/i.test(trimmed)) {
    return trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (EBUILDER_HOST_PATTERN.test(parsed.hostname)) {
      return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.href;
  }

  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${origin}${normalizedPath}`;
}

/**
 * Waits for an e-Builder ASP.NET WebForms page (and its inner #contentFrame iframe, if present)
 * to finish loading, async postbacks, and jQuery AJAX requests.
 */
export async function waitForEBuilderPageToSettle(
  page: puppeteer.Page,
  timeoutMs: number = 15_000,
): Promise<void> {
  if (typeof page.waitForFunction === 'function') {
    await page
      .waitForFunction(
        () => {
          const checkWindowIdle = (
            win: Window | null | undefined,
            doc: Document | null | undefined,
          ) => {
            if (!win || !doc) return true;
            if (doc.readyState !== 'complete') return false;

            const prm = (win as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
            const isPostBackIdle = !(prm?.get_isInAsyncPostBack?.() ?? false);

            const isJQueryIdle =
              typeof (win as any).jQuery === 'undefined' || ((win as any).jQuery.active ?? 0) === 0;

            return isPostBackIdle && isJQueryIdle;
          };

          if (!checkWindowIdle(window, document)) {
            return false;
          }

          const iframe = document.querySelector<HTMLIFrameElement>(
            'iframe#contentFrame, iframe[name="contentFrame"], iframe',
          );
          if (iframe) {
            try {
              if (!checkWindowIdle(iframe.contentWindow, iframe.contentDocument)) {
                return false;
              }
            } catch {
              // Cross-origin iframe; ignore
            }
          }

          return true;
        },
        { timeout: timeoutMs },
      )
      .catch(() => null);
  }

  if (typeof page.waitForNetworkIdle === 'function') {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5_000 }).catch(() => null);
  }
}

async function waitForSelectorInPageOrFrame(
  page: puppeteer.Page,
  selector: string,
  timeoutMs: number = 30_000,
): Promise<void> {
  if (typeof page.waitForFunction === 'function') {
    await page.waitForFunction(
      (sel) => {
        if (document.querySelector(sel)) return true;
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe?.contentDocument?.querySelector(sel)) return true;
        } catch {}
        return false;
      },
      { timeout: timeoutMs },
      selector,
    );
    return;
  }

  if (typeof page.waitForSelector === 'function') {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  }
}

export async function inspectPage(page: puppeteer.Page): Promise<PageInspectionResult> {
  return await page.evaluate(() => {
    const getDoc = () => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe#contentFrame, iframe[name="contentFrame"], iframe',
      );
      try {
        if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
          return {
            doc: iframe.contentDocument,
            frameUrl: iframe.contentWindow?.location?.href || iframe.src || null,
          };
        }
      } catch {}
      return { doc: document, frameUrl: null };
    };

    const { doc, frameUrl } = getDoc();

    // Breadcrumbs
    const breadcrumbs: string[] = [];
    const bcElements = document.querySelectorAll(
      '.breadcrumb, .breadcrumbs, .navigationPath, #navigationPath, span.NavPath',
    );
    bcElements.forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !breadcrumbs.includes(text)) breadcrumbs.push(text);
    });

    // Active Tab
    let activeTab: string | null = null;
    const tabEl = document.querySelector(
      '.activeTab, .rtsSelected, .tabSelected, li.selected a, a.tab-active',
    );
    if (tabEl) {
      activeTab = (tabEl.textContent || '').replace(/\s+/g, ' ').trim() || null;
    }

    // Alerts & Messages
    const alerts: string[] = [];
    doc
      .querySelectorAll(
        '.errorMessage, .error-message, .alert, .alert-danger, .validation-summary-errors, #lblError, #lblMessage',
      )
      .forEach((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && !alerts.includes(text)) alerts.push(text);
      });

    // Label finder helper
    const findLabel = (el: HTMLElement): string | undefined => {
      const id = el.id;
      if (id) {
        const lbl = doc.querySelector(`label[for="${id}"]`);
        if (lbl && lbl.textContent?.trim()) {
          return lbl.textContent.replace(/\s+/g, ' ').trim();
        }
      }
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel.textContent?.trim()) {
        return parentLabel.textContent.replace(/\s+/g, ' ').trim();
      }
      const tr = el.closest('tr');
      if (tr) {
        const tdLabel = tr.querySelector('td.label, td.fieldLabel, td.formLabel, td:first-child');
        if (tdLabel && tdLabel !== el.closest('td') && tdLabel.textContent?.trim()) {
          return tdLabel.textContent.replace(/\s+/g, ' ').trim();
        }
      }
      return (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        undefined
      );
    };

    const isRequired = (el: HTMLElement, label?: string): boolean => {
      if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true')
        return true;
      if (label && (label.includes('*') || label.toLowerCase().includes('(required)'))) return true;
      const tr = el.closest('tr');
      if (
        tr &&
        tr.querySelector('.req, .required, span[style*="color:red"], span[style*="color: Red"]')
      )
        return true;
      return false;
    };

    // Fields
    const fields: PageInspectionField[] = [];

    // Inputs
    doc.querySelectorAll('input').forEach((input) => {
      const type = (input.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;
      if (input.name && input.name.startsWith('__')) return;

      const label = findLabel(input);
      const required = isRequired(input, label);
      const value = type === 'checkbox' || type === 'radio' ? input.checked : input.value;

      fields.push({
        id: input.id || undefined,
        name: input.name || undefined,
        type,
        label,
        value,
        required,
        disabled: input.disabled || undefined,
      });
    });

    // Textareas
    doc.querySelectorAll('textarea').forEach((ta) => {
      if (ta.name && ta.name.startsWith('__')) return;
      const label = findLabel(ta);
      fields.push({
        id: ta.id || undefined,
        name: ta.name || undefined,
        type: 'textarea',
        label,
        value: ta.value,
        required: isRequired(ta, label),
        disabled: ta.disabled || undefined,
      });
    });

    // Selects
    doc.querySelectorAll('select').forEach((sel) => {
      if (sel.name && sel.name.startsWith('__')) return;
      const label = findLabel(sel);
      const options = Array.from(sel.options).map((o) => ({
        value: o.value,
        text: (o.text || '').trim(),
        selected: o.selected || undefined,
      }));
      fields.push({
        id: sel.id || undefined,
        name: sel.name || undefined,
        type: 'select',
        label,
        value: sel.value,
        required: isRequired(sel, label),
        disabled: sel.disabled || undefined,
        options,
      });
    });

    // RadComboBoxes (Telerik)
    doc.querySelectorAll('.RadComboBox').forEach((rcb) => {
      const id = rcb.id || '';
      const inputEl = rcb.querySelector<HTMLInputElement>('.rcbInput');
      const hiddenVal = doc.querySelector<HTMLInputElement>(
        `input[id="${id}_Value"], input[name="${id}_Value"]`,
      );
      const label = findLabel(rcb as HTMLElement) || (inputEl ? findLabel(inputEl) : undefined);

      const options: Array<{ value: string; text: string; selected?: boolean | undefined }> = [];
      const dropDown = doc.querySelector(`#${id}_DropDown, div[id$="${id}_DropDown"]`);
      if (dropDown) {
        dropDown.querySelectorAll('li.rcbItem').forEach((li) => {
          options.push({
            value: li.getAttribute('data-value') || (li.textContent || '').trim(),
            text: (li.textContent || '').trim(),
            selected:
              li.classList.contains('rcbHovered') || li.classList.contains('rcbItemChecked')
                ? true
                : undefined,
          });
        });
      }

      fields.push({
        id: id || undefined,
        name: hiddenVal?.name || inputEl?.name || id || undefined,
        type: 'radcombobox',
        label,
        value: hiddenVal?.value || inputEl?.value || null,
        required: isRequired(rcb as HTMLElement, label),
        disabled: inputEl?.disabled || undefined,
        options: options.length > 0 ? options : undefined,
      });
    });

    // Actions
    const actions: PageInspectionAction[] = [];
    const actionSelectors =
      'input[type="submit"], input[type="button"], button, a.btn, a.button, a.rwOkBtn, a[id*="btn"], a[id*="Button"], a[id*="Save"], a[id*="Submit"]';
    doc.querySelectorAll(actionSelectors).forEach((btn) => {
      const text = ((btn as HTMLInputElement).value || btn.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return;
      const tag = btn.tagName.toLowerCase();
      const type = tag === 'a' ? 'link' : (btn as HTMLInputElement).type || 'button';
      actions.push({
        id: btn.id || undefined,
        text,
        type,
        disabled: (btn as HTMLButtonElement).disabled || undefined,
      });
    });

    // Tables / Grids
    const tables: PageInspectionTable[] = [];
    const tableElements = doc.querySelectorAll(
      'table.rgMasterTable, table.grid, table[id*="Grid"], table[id*="table"], table',
    );
    tableElements.forEach((tbl) => {
      const headers: string[] = [];
      tbl.querySelectorAll('thead th, tr.rgHeader th, tr:first-child th').forEach((th) => {
        const hText = (th.textContent || '').replace(/\s+/g, ' ').trim();
        if (hText) headers.push(hText);
      });

      if (headers.length === 0) return;

      const rows: Record<string, string>[] = [];
      const trList = Array.from(tbl.querySelectorAll('tbody tr, tr.rgRow, tr.rgAltRow')).filter(
        (tr) => !tr.querySelector('th'),
      );
      const maxSample = Math.min(trList.length, 25);

      for (let i = 0; i < maxSample; i++) {
        const tr = trList[i];
        if (!tr) continue;
        const rowObj: Record<string, string> = {};
        const tds = tr.querySelectorAll('td');
        tds.forEach((td, idx) => {
          const header = headers[idx] || `Column_${idx + 1}`;
          rowObj[header] = (td.textContent || '').replace(/\s+/g, ' ').trim();
        });
        if (Object.keys(rowObj).length > 0) {
          rows.push(rowObj);
        }
      }

      tables.push({
        id: tbl.id || undefined,
        headers,
        rowCount: trList.length,
        sampleRows: rows,
      });
    });

    return {
      title: doc.title || document.title || '',
      url: window.location.href,
      frameUrl,
      breadcrumbs,
      activeTab,
      fields,
      actions,
      tables,
      alerts,
    };
  });
}

const inBrowserEbHelper = `
  (function() {
    if (window.eb) return;
    window.eb = {
      getContentDocument: function() {
        var iframe = document.querySelector('iframe#contentFrame, iframe[name="contentFrame"], iframe');
        try {
          if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
            return iframe.contentDocument;
          }
        } catch(e) {}
        return document;
      },
      findField: function(nameOrLabel) {
        var doc = this.getContentDocument();
        if (!nameOrLabel) return null;
        var direct = doc.getElementById(nameOrLabel) || doc.querySelector('[name="' + nameOrLabel + '"]');
        if (direct) return direct;
        var lower = nameOrLabel.toLowerCase().trim();
        var all = doc.querySelectorAll('input, select, textarea');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if ((el.id && el.id.toLowerCase().indexOf(lower) !== -1) ||
              (el.name && el.name.toLowerCase().indexOf(lower) !== -1)) {
            return el;
          }
          if (el.id) {
            var lbl = doc.querySelector('label[for="' + el.id + '"]');
            if (lbl && (lbl.textContent || '').toLowerCase().indexOf(lower) !== -1) {
              return el;
            }
          }
        }
        return null;
      },
      getRadComboBox: function(idOrName) {
        var doc = this.getContentDocument();
        var rcb = doc.getElementById(idOrName) || doc.querySelector('.RadComboBox#' + idOrName) || this.findField(idOrName);
        if (!rcb) return null;
        var rcbEl = rcb.classList && rcb.classList.contains('RadComboBox') ? rcb : rcb.closest('.RadComboBox');
        if (!rcbEl) return null;
        var id = rcbEl.id;
        var inputEl = rcbEl.querySelector('.rcbInput');
        var hiddenVal = doc.querySelector('input[id="' + id + '_Value"], input[name="' + id + '_Value"]');
        var options = [];
        var dropDown = doc.querySelector('#' + id + '_DropDown, div[id$="' + id + '_DropDown"]');
        if (dropDown) {
          var items = dropDown.querySelectorAll('li.rcbItem');
          for (var j = 0; j < items.length; j++) {
            options.push((items[j].textContent || '').trim());
          }
        }
        return {
          id: id,
          text: inputEl ? inputEl.value : '',
          value: hiddenVal ? hiddenVal.value : '',
          options: options
        };
      },
      setRadComboBox: function(idOrName, valueOrText) {
        var info = this.getRadComboBox(idOrName);
        if (!info) return false;
        var doc = this.getContentDocument();
        var hiddenVal = doc.querySelector('input[id="' + info.id + '_Value"], input[name="' + info.id + '_Value"]');
        var inputEl = doc.querySelector('#' + info.id + ' .rcbInput');
        if (hiddenVal) hiddenVal.value = valueOrText;
        if (inputEl) inputEl.value = valueOrText;
        if (typeof window.$find === 'function') {
          var combo = window.$find(info.id);
          if (combo && typeof combo.findItemByText === 'function') {
            var item = combo.findItemByText(valueOrText) || combo.findItemByValue(valueOrText);
            if (item) item.select();
          }
        }
        return true;
      },
      getTable: function(selectorOrId, maxRows) {
        var doc = this.getContentDocument();
        var tbl = doc.getElementById(selectorOrId) || doc.querySelector(selectorOrId);
        if (!tbl) return null;
        var headers = [];
        var ths = tbl.querySelectorAll('thead th, tr.rgHeader th, tr:first-child th');
        for (var i = 0; i < ths.length; i++) {
          headers.push((ths[i].textContent || '').replace(/\\s+/g, ' ').trim());
        }
        var rows = [];
        var trs = tbl.querySelectorAll('tbody tr, tr.rgRow, tr.rgAltRow');
        var limit = Math.min(trs.length, maxRows || 50);
        for (var r = 0; r < limit; r++) {
          var tr = trs[r];
          if (tr.querySelector('th')) continue;
          var tds = tr.querySelectorAll('td');
          var rowObj = {};
          for (var c = 0; c < tds.length; c++) {
            var h = headers[c] || ('Column_' + (c + 1));
            rowObj[h] = (tds[c].textContent || '').replace(/\\s+/g, ' ').trim();
          }
          rows.push(rowObj);
        }
        return { headers: headers, rowCount: trs.length, rows: rows };
      }
    };
  })();
`;

async function evaluateDomScript(
  page: puppeteer.Page,
  script: string,
  arg: unknown,
): Promise<unknown> {
  if (typeof page.evaluate === 'function') {
    await page.evaluate(inBrowserEbHelper).catch(() => {});
  }

  return await page.evaluate(
    async (code: string, passedArg: unknown) => {
      const eb = (window as any).eb;
      try {
        const evaluated = (0, eval)(`(${code})`);
        if (typeof evaluated === 'function') {
          return await evaluated(passedArg, eb);
        }
        return await evaluated;
      } catch (firstErr) {
        if (!(firstErr instanceof SyntaxError)) {
          throw firstErr;
        }

        try {
          return await (0, eval)(code);
        } catch (secondErr) {
          if (!(secondErr instanceof SyntaxError)) {
            throw secondErr;
          }
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction('arg', 'eb', code);
          return await fn(passedArg, eb);
        }
      }
    },
    script,
    arg,
  );
}

async function evaluatePuppeteerScript(
  script: string,
  execContext: PuppeteerExecContext,
): Promise<unknown> {
  try {
    const evaluated = (0, eval)(`(${script})`);
    if (typeof evaluated === 'function') {
      return await evaluated(execContext);
    }
    return await evaluated;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      'ctx',
      'const { page, browser, context, env, origin, url, arg, settle, inspect } = ctx;\n' + script,
    );
    return await fn(execContext);
  }
}

/**
 * Opens an isolated browser context in the active e-Builder session, navigates to the target
 * e-Builder page, optionally runs a DOM or Puppeteer script, and returns the result + updated cookies.
 */
export async function executeInSession(
  options: ExecuteInSessionOptions,
): Promise<ExecuteInSessionResult> {
  const {
    env,
    cookies,
    browser,
    headless = true,
    url,
    waitForSelector,
    script,
    mode = 'dom',
    arg,
    screenshotPath,
    screenshotOnFailure = true,
    inspect = false,
    blockAssets,
  } = options;

  const origin = `https://${env}.${baseurl}`;
  const targetUrl = resolveSessionUrl(env, url);
  const browserInstance =
    browser ||
    (await BrowserManager.getInstance().getBrowser(
      headless,
      headless ? ['--window-size=1440,900'] : undefined,
    ));

  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;
  let finalUrl = targetUrl;
  let title = '';
  let frameUrl: string | null = null;
  let capturedScreenshotPath: string | null = screenshotPath ?? null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();

    const shouldBlockAssets = blockAssets ?? (!screenshotPath && !screenshotOnFailure);
    await optimizePageForAutomation(page, { blockAssets: shouldBlockAssets });

    if (typeof page.on === 'function') {
      page.on('dialog', async (dialog) => {
        try {
          await dialog.dismiss();
        } catch {}
      });
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForEBuilderPageToSettle(page);

    if (waitForSelector) {
      await waitForSelectorInPageOrFrame(page, waitForSelector);
    }

    if (typeof page.url === 'function') {
      finalUrl = page.url();
    }

    if (typeof page.title === 'function') {
      try {
        title = await page.title();
      } catch {}
    }

    if (typeof page.evaluate === 'function') {
      try {
        const meta = await page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>(
            'iframe#contentFrame, iframe[name="contentFrame"], iframe',
          );
          let innerHref: string | null = null;
          try {
            innerHref = iframe?.contentWindow?.location?.href || iframe?.src || null;
          } catch {
            innerHref = iframe?.src || null;
          }
          return {
            docTitle: document.title || '',
            innerHref,
          };
        });
        if (!title && meta?.docTitle) {
          title = meta.docTitle;
        }
        if (meta?.innerHref) {
          frameUrl = meta.innerHref;
        }
      } catch {}
    }

    let inspection: PageInspectionResult | undefined;
    if (inspect) {
      inspection = await inspectPage(page);
    }

    let result: unknown = null;
    if (script && script.trim().length > 0) {
      if (mode === 'puppeteer') {
        result = await evaluatePuppeteerScript(script, {
          page,
          browser: browserInstance,
          context,
          env,
          origin,
          url: finalUrl,
          arg,
          settle: () => waitForEBuilderPageToSettle(page!),
          inspect: () => inspectPage(page!),
        });
      } else {
        result = await evaluateDomScript(page, script, arg);
      }
    }

    if (!script || script.trim().length === 0) {
      result = inspect
        ? inspection
        : {
            url: finalUrl,
            title,
            frameUrl,
          };
    }

    if (screenshotPath && typeof page.screenshot === 'function') {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    const updatedCookies =
      typeof context.cookies === 'function' ? await context.cookies() : cookies;

    return {
      url: finalUrl,
      title,
      frameUrl,
      result,
      inspection,
      cookies: updatedCookies,
      screenshotPath: screenshotPath ?? null,
    };
  } catch (err: any) {
    if (page) {
      try {
        if (typeof page.url === 'function') finalUrl = page.url();
        if (typeof page.title === 'function') title = await page.title().catch(() => '');
        if (typeof page.evaluate === 'function') {
          const meta = await page
            .evaluate(() => {
              const iframe = document.querySelector<HTMLIFrameElement>(
                'iframe#contentFrame, iframe[name="contentFrame"], iframe',
              );
              return iframe?.src || null;
            })
            .catch(() => null);
          if (meta) frameUrl = meta;
        }
        if (
          screenshotOnFailure &&
          !capturedScreenshotPath &&
          typeof page.screenshot === 'function'
        ) {
          const failureFile = path.join(os.tmpdir(), `eb-exec-error-${Date.now()}.png`);
          await page.screenshot({ path: failureFile, fullPage: true }).catch(() => null);
          capturedScreenshotPath = failureFile;
        }
      } catch {}
    }

    throw new ExecuteInSessionError(err.message || 'Execution in session failed', {
      url: finalUrl,
      title,
      frameUrl,
      screenshotPath: capturedScreenshotPath,
      cause: err,
    });
  } finally {
    if (page && typeof page.close === 'function') {
      await page.close().catch(() => {});
    }
    if (typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}
