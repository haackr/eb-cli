import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import {
  classifyNavigationError,
  detectLoginPage,
  safePageUrl,
  SessionCheckError,
  sessionCheckErrorFor,
  type SessionCheckReason,
} from './session-check.js';

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
  /** Machine-readable error code, e.g. SessionExpiredError, NetworkError, EXECUTION_FAILED. */
  public code: string = 'EXECUTION_FAILED';
  /** Set when the failure was a classified session/navigation problem. */
  public reason?: SessionCheckReason | undefined;

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
      if (details.cause instanceof SessionCheckError) {
        this.code = details.cause.code;
        this.reason = details.cause.reason;
      }
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
  /**
   * Verify the target navigation did not land on a login page (default: true). This replaces
   * a separate pre-flight session check: loading any authenticated page already extends the
   * ASP.NET sliding session, and the refreshed cookies are returned in the result.
   */
  verifyAuth?: boolean | undefined;
  /**
   * How to answer alert/confirm/prompt dialogs (default: dismiss). `manual` leaves them to the
   * script. A Puppeteer script that registers its own `page.on('dialog')` listener always wins.
   */
  dialogPolicy?: DialogPolicy | undefined;
};

export type ExecuteInSessionResult = {
  url: string;
  title: string;
  frameUrl: string | null;
  result: unknown;
  inspection?: PageInspectionResult | undefined;
  cookies: puppeteer.Cookie[];
  screenshotPath: string | null;
  /** HTTP status of the main navigation response, when available. */
  httpStatus?: number | undefined;
  /** Dialogs raised during the run and how they were handled. */
  dialogs: ExecDialogRecord[];
};

export type PuppeteerExecContext = {
  page: puppeteer.Page;
  browser: puppeteer.Browser;
  context: puppeteer.BrowserContext;
  env: Environment;
  origin: string;
  url: string;
  arg: unknown;
  /** Alias of `arg`. */
  args: unknown;
  fs: typeof import('fs');
  path: typeof import('path');
  os: typeof import('os');
  /** Node-side proxy for the in-browser `eb` helper (results must be JSON-serializable). */
  eb: Record<string, (...args: unknown[]) => Promise<unknown>>;
  settle: () => Promise<void>;
  inspect: () => Promise<PageInspectionResult>;
};

export type DialogPolicy = 'accept' | 'dismiss' | 'manual';

export type ExecDialogRecord = {
  type: string;
  message: string;
  defaultValue: string;
  handled: 'accepted' | 'dismissed' | 'script';
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
  options: { networkIdle?: boolean } = {},
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
            'iframe#contentFrame, iframe[name="contentFrame"]',
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

  if (options.networkIdle !== false && typeof page.waitForNetworkIdle === 'function') {
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
          'iframe#contentFrame, iframe[name="contentFrame"]',
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
        'iframe#contentFrame, iframe[name="contentFrame"]',
      );
      try {
        const href = iframe?.contentWindow?.location?.href || iframe?.getAttribute('src') || '';
        if (
          iframe &&
          href &&
          href !== 'about:blank' &&
          iframe.contentDocument?.body &&
          iframe.contentDocument.body.children.length > 0
        ) {
          return { doc: iframe.contentDocument, frameUrl: href };
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

      // e-Builder TableGrid headers are often <td> cells in the first row (sort links).
      let headerRow: Element | null = null;
      const isGrid =
        /TableGrid|rgMasterTable/.test(tbl.className || '') || /grd|Grid/.test(tbl.id || '');
      if (headers.length === 0 && isGrid) {
        headerRow = (tbl as HTMLTableElement).rows?.[0] ?? null;
        headerRow?.querySelectorAll('td').forEach((td, idx) => {
          headers.push((td.textContent || '').replace(/\s+/g, ' ').trim() || `Column_${idx + 1}`);
        });
      }

      if (headers.length === 0) return;

      const rows: Record<string, string>[] = [];
      const trList = Array.from(tbl.querySelectorAll('tbody tr, tr.rgRow, tr.rgAltRow')).filter(
        (tr) => !tr.querySelector('th') && tr !== headerRow,
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
        // Only the e-Builder #contentFrame wrapper counts. Telerik/analytics controls inject
        // hidden about:blank iframes, which must never be mistaken for page content.
        var iframe = document.querySelector('iframe#contentFrame, iframe[name="contentFrame"]');
        try {
          var href = (iframe && ((iframe.contentWindow && iframe.contentWindow.location && iframe.contentWindow.location.href) || iframe.getAttribute('src'))) || '';
          if (iframe && href && href !== 'about:blank' && iframe.contentDocument && iframe.contentDocument.body &&
              iframe.contentDocument.body.children.length > 0) {
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
        var headerRow = null;
        if (headers.length === 0 && tbl.rows && tbl.rows.length > 0) {
          // e-Builder TableGrid headers are often <td> cells in the first row.
          headerRow = tbl.rows[0];
          var htds = headerRow.querySelectorAll('td');
          for (var hi = 0; hi < htds.length; hi++) {
            headers.push((htds[hi].textContent || '').replace(/\\s+/g, ' ').trim() || ('Column_' + (hi + 1)));
          }
        }
        var rows = [];
        var trs = Array.prototype.filter.call(
          tbl.querySelectorAll('tbody tr, tr.rgRow, tr.rgAltRow'),
          function(row) { return row !== headerRow && !row.querySelector('th'); }
        );
        var limit = Math.min(trs.length, maxRows || 50);
        for (var r = 0; r < limit; r++) {
          var tr = trs[r];
          var tds = tr.querySelectorAll('td');
          var rowObj = {};
          for (var c = 0; c < tds.length; c++) {
            var h = headers[c] || ('Column_' + (c + 1));
            rowObj[h] = (tds[c].textContent || '').replace(/\\s+/g, ' ').trim();
          }
          rows.push(rowObj);
        }
        return { headers: headers, rowCount: trs.length, rows: rows };
      },
      _resolveForm: function(docOrForm) {
        var src = docOrForm;
        if (typeof src === 'string') {
          src = this.getContentDocument().querySelector(src);
          if (!src) throw new Error('eb.buildFormParams: no element matches ' + docOrForm);
        }
        if (!src) src = this.getContentDocument();
        if (src.tagName && src.tagName.toUpperCase() === 'FORM') return src;
        var doc = src.nodeType === 9 ? src : (src.ownerDocument || document);
        var form = doc.getElementById('aspnetForm') || doc.forms[0];
        if (!form) throw new Error('eb.buildFormParams: no <form> found');
        return form;
      },
      _fieldName: function(form, shortName) {
        // ASP.NET prefixes control names (ctl00$ContentPlaceHolder1$btnSave); match either form.
        var els = form.elements;
        for (var i = 0; i < els.length; i++) {
          var n = els[i].name || '';
          if (n === shortName) return n;
        }
        for (var j = 0; j < els.length; j++) {
          var m = els[j].name || '';
          if (m.slice(-(shortName.length + 1)) === '$' + shortName) return m;
        }
        return shortName;
      },
      /**
       * Serializes an ASP.NET WebForms form (incl. __VIEWSTATE / __EVENTVALIDATION) the way the
       * browser would, for fast fetch() postbacks. Overrides match full or short control names;
       * a null override removes the field.
       */
      // e-Builder setup pages mark some inputs encode="1"; their submit handler runs
      // encodeURIComponent on those values before posting, so a fetch() post must too.
      _encodeIfMarked: function(el, value) {
        var marked = el && el.getAttribute && el.getAttribute('encode') === '1';
        return marked ? encodeURIComponent(value) : value;
      },
      buildFormParams: function(docOrForm, overrides, eventTarget, eventArg) {
        var form = this._resolveForm(docOrForm);
        var params = new URLSearchParams();
        var els = form.elements;
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!el.name || el.disabled) continue;
          var type = (el.type || '').toLowerCase();
          if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset' || type === 'file') continue;
          if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
          if (type === 'select-multiple') {
            for (var o = 0; o < el.options.length; o++) {
              if (el.options[o].selected) params.append(el.name, el.options[o].value);
            }
            continue;
          }
          params.append(el.name, this._encodeIfMarked(el, el.value));
        }
        if (eventTarget !== undefined && eventTarget !== null) {
          params.set('__EVENTTARGET', eventTarget);
          params.set('__EVENTARGUMENT', eventArg || '');
        }
        var o2 = overrides || {};
        for (var key in o2) {
          if (!Object.prototype.hasOwnProperty.call(o2, key)) continue;
          var name = this._fieldName(form, key);
          if (o2[key] === null) params.delete(name);
          else params.set(name, this._encodeIfMarked(form.elements.namedItem(name), String(o2[key])));
        }
        return params;
      },
      /** POSTs a WebForms form via fetch(). Resolves { url, status, html, doc }. */
      postWebForm: function(url, docOrForm, overrides, eventTarget, eventArg) {
        var form = this._resolveForm(docOrForm);
        var params = this.buildFormParams(form, overrides, eventTarget, eventArg);
        var base = (form.ownerDocument && form.ownerDocument.location && form.ownerDocument.location.href) || location.href;
        if (base === 'about:blank') base = location.href;
        var target = new URL(url || form.getAttribute('action') || base, base).href;
        return fetch(target, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        }).then(function(r) {
          return r.text().then(function(html) {
            return { url: r.url, status: r.status, html: html, doc: new DOMParser().parseFromString(html, 'text/html') };
          });
        });
      },
      _fetchText: function(url, init) {
        return fetch(url, Object.assign({ credentials: 'include' }, init || {})).then(function(r) {
          return r.text().then(function(text) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
            if (/\\/login(\\/|\\.aspx)/i.test(r.url) || /id\\.trimble\\.com/i.test(r.url)) {
              throw new Error('Session expired: redirected to ' + r.url);
            }
            return { text: text, contentType: r.headers.get('content-type') || '', url: r.url };
          });
        });
      },
      _stripBraces: function(guid) {
        return String(guid || '').trim().replace(/^\\{|\\}$/g, '');
      },
      /**
       * Fetches a workflow definition: { xml: '<ebWorkflow>...', isActive }.
       * Reads the designer's securityToken via fetch() (no navigation, so no blocking alerts),
       * then calls ProcessesService.asmx/GetWorkflowData exactly like the designer does.
       * version: 3 = published, 1 = saved draft; defaults to the version the designer loads.
       */
      getWorkflowData: function(processId, workflowId, version) {
        var self = this;
        var pid = this._stripBraces(processId);
        var wid = this._stripBraces(workflowId);
        if (!pid || !wid) return Promise.reject(new Error('eb.getWorkflowData(processId, workflowId) requires both GUIDs'));
        var designerUrl = location.origin + '/da2/Setup/Admin/Processes/WorkflowDesigner.aspx?WorkflowID={' + wid + '}&ProcessID={' + pid + '}&mode=0';
        var tokenOf = function(html) {
          var m = html.match(/"token"\\s*:\\s*"([^"]+)"/i) || html.match(/\\btoken\\s*:\\s*['"]([^'"]+)['"]/i);
          return m ? m[1] : null;
        };
        var versionOf = function(html) {
          var m = html.match(/ucDesigner\\.load\\([^)]*,\\s*(\\d+)\\s*\\)/);
          return m ? Number(m[1]) : 3;
        };
        return this._fetchText(designerUrl).then(function(res) {
          if (tokenOf(res.text)) return res;
          if (res.text.indexOf('btnLoadWorkflow') === -1) return res;
          // "Choose Workflow Version" prompt: choose Published and continue once.
          var doc = new DOMParser().parseFromString(res.text, 'text/html');
          var params = self.buildFormParams(self._resolveForm(doc), {
            'ctl00$contentSection$rbPublished': 'rbPublished',
            'ctl00$contentSection$btnLoadWorkflow': 'Continue'
          });
          return self._fetchText(designerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
          });
        }).then(function(res) {
          var token = tokenOf(res.text);
          if (!token) throw new Error('Could not extract the workflow designer securityToken from ' + designerUrl);
          var v = version === undefined || version === null ? versionOf(res.text) : Number(version);
          return fetch(location.origin + '/da2/Processes/ProcessesService.asmx/GetWorkflowData', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ securityToken: token, processID: pid, workflowID: wid, version: v })
          });
        }).then(function(r) {
          return r.text().then(function(text) {
            var body = null;
            try { body = JSON.parse(text); } catch (e) {}
            if (!r.ok || !body || !body.d) {
              var msg = (body && (body.Message || body.message)) || ('HTTP ' + r.status);
              throw new Error('GetWorkflowData failed: ' + msg);
            }
            return { xml: body.d.xml, isActive: Boolean(body.d.isActive) };
          });
        });
      },
      /** Fetches a page layout definition ('<?xml ...><ebLayout>...') by ProcessID + LayoutID. */
      getLayoutXml: function(processId, layoutId) {
        var pid = this._stripBraces(processId);
        var lid = this._stripBraces(layoutId);
        if (!pid || !lid) return Promise.reject(new Error('eb.getLayoutXml(processId, layoutId) requires both GUIDs'));
        var url = location.origin + '/da2/Setup/Admin/Processes/AddEditLayout.aspx?rand=' + Math.random() +
          '&ajaxRefresh=1&LayoutID=' + lid + '&ProcessID=' + pid + '&defSecID=&moduleSecID=&mode=';
        return this._fetchText(url).then(function(res) {
          if (!/<ebLayout\\b/.test(res.text)) {
            throw new Error('Layout request did not return <ebLayout> XML (check the ProcessID/LayoutID)');
          }
          return res.text;
        });
      },
      /** Runs a custom report and returns its full CSV export by ReportID GUID. */
      exportReportCsv: function(reportId) {
        var self = this;
        var url = location.origin + '/da2/Reports/ReportResults.aspx?ReportID=' + encodeURIComponent(reportId);
        return this._fetchText(url).then(function(res) {
          var doc = new DOMParser().parseFromString(res.text, 'text/html');
          var form = self._resolveForm(doc);
          var params = self.buildFormParams(form, { rblExportTypes: '5', btnExportType: 'Export' });
          return self._fetchText(res.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
          });
        }).then(function(res) {
          if (/text\\/html/i.test(res.contentType) && /<html/i.test(res.text)) {
            throw new Error('Report export returned HTML instead of CSV (check the ReportID or export options)');
          }
          return res.text;
        });
      }
    };
  })();
`;

const EXPORT_PREFIX = /^\s*(?:export\s+default\b|module\.exports\s*=|exports\.default\s*=)\s*/;
const EXPORT_LINE =
  /^([ \t]*)(?:export\s+default\b|module\.exports\s*=|exports\.default\s*=)[ \t]*/m;

/**
 * Accepts module-style script files as well as bare expressions/functions. Strips a leading
 * `export default` / `module.exports =` / `exports.default =`; when helpers precede the export,
 * wraps the file in an IIFE that returns the exported value.
 */
export function normalizeUserScript(rawScript: string): string {
  let code = rawScript
    .replace(/^\uFEFF/, '')
    .replace(/^#!.*\n/, '')
    .trim();
  if (EXPORT_PREFIX.test(code)) {
    code = code.replace(EXPORT_PREFIX, '');
  } else if (EXPORT_LINE.test(code)) {
    code = `(() => {\n${code.replace(EXPORT_LINE, '$1return ')}\n})()`;
  }
  return code.replace(/;\s*$/, '');
}

const PUPPETEER_PARAM_DESTRUCTURE =
  /^\s*(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\{[^}]*\b(?:page|browser|context|eb|fs|path|os|settle|inspect|origin)\b[^}]*\}/;
const BARE_PAGE_PARAM = /^\s*(?:async\s+)?(?:(?:function\s*\w*\s*)?\(\s*page\s*[,)]|page\s*=>)/;
const PAGE_API_CALL =
  /\bpage\.(?:goto|evaluate|\$eval|\$\$eval|\$|\$\$|click|type|waitForSelector|waitForNavigation|waitForFunction|waitForNetworkIdle|frames|mainFrame|setRequestInterception|screenshot|keyboard|mouse|on)\b/;

/** Heuristic: does this (normalized) script expect the Node Puppeteer context? */
export function looksLikePuppeteerScript(code: string): boolean {
  const normalized = normalizeUserScript(code);
  return (
    PUPPETEER_PARAM_DESTRUCTURE.test(normalized) ||
    BARE_PAGE_PARAM.test(normalized) ||
    PAGE_API_CALL.test(normalized)
  );
}

/** Injects the in-browser `window.eb` helper into the page (idempotent). */
export async function injectEbHelper(page: puppeteer.Page): Promise<void> {
  await page.evaluate(inBrowserEbHelper);
}

async function evaluateDomScript(
  page: puppeteer.Page,
  script: string,
  arg: unknown,
): Promise<unknown> {
  if (typeof page.evaluate === 'function') {
    await page.evaluate(inBrowserEbHelper).catch(() => {});
  }

  const normalizedScript = normalizeUserScript(script);
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
    normalizedScript,
    arg,
  );
}

async function evaluatePuppeteerScript(
  script: string,
  execContext: PuppeteerExecContext,
): Promise<unknown> {
  const code = normalizeUserScript(script);
  let evaluated: unknown;
  try {
    evaluated = (0, eval)(`(${code})`);
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      'ctx',
      'const { page, browser, context, env, origin, url, arg, args, fs, path, os, eb, settle, inspect } = ctx;\n' +
        code,
    );
    return await fn(execContext);
  }

  if (typeof evaluated === 'function') {
    // Agents often write `async (page) => ...`; hand them the page instead of the context.
    if (BARE_PAGE_PARAM.test(Function.prototype.toString.call(evaluated))) {
      return await evaluated(execContext.page, execContext.arg, execContext);
    }
    return await evaluated(execContext);
  }
  return await evaluated;
}

/**
 * Node-side proxy for the in-browser `window.eb` helper: `await eb.getTable('#grid')` runs the
 * helper inside the page and returns its (JSON-serializable) result.
 */
function createNodeEbHelper(
  page: puppeteer.Page,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return async (...callArgs: unknown[]) => {
        await page.evaluate(inBrowserEbHelper).catch(() => {});
        return await page.evaluate(
          async (m: string, a: unknown[]) => {
            const helper = (window as any).eb;
            if (!helper || typeof helper[m] !== 'function') {
              throw new Error(`eb.${m} is not a function`);
            }
            const out = await helper[m](...a);
            if (out instanceof URLSearchParams) return out.toString();
            if (out && typeof out === 'object' && 'doc' in out && out.doc instanceof Document) {
              const { doc: _doc, ...rest } = out;
              return rest;
            }
            return out;
          },
          method,
          callArgs,
        );
      };
    },
  });
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
    verifyAuth = true,
    dialogPolicy = 'dismiss',
  } = options;
  const dialogs: ExecDialogRecord[] = [];

  const origin = `https://${env}.${baseurl}`;
  const targetUrl = resolveSessionUrl(env, url);
  const browserInstance =
    browser ||
    (await BrowserManager.getInstance().getBrowser(
      headless,
      headless ? ['--window-size=1440,900'] : undefined,
      false,
      { allowDaemon: true },
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
      const pageRef = page;
      pageRef.on('dialog', async (dialog: puppeteer.Dialog) => {
        const record: ExecDialogRecord = {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
          handled: 'script',
        };
        dialogs.push(record);
        // Yield to a script-registered listener (ours is always registered first).
        const listenerCount =
          typeof pageRef.listenerCount === 'function' ? pageRef.listenerCount('dialog') : 1;
        if (dialogPolicy === 'manual' || listenerCount > 1) return;
        try {
          if (dialogPolicy === 'accept') {
            await dialog.accept();
            record.handled = 'accepted';
          } else {
            await dialog.dismiss();
            record.handled = 'dismissed';
          }
        } catch {}
      });
    }

    let httpStatus: number | undefined;
    try {
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      httpStatus = typeof response?.status === 'function' ? response.status() : undefined;
    } catch (navErr) {
      const reason = classifyNavigationError(navErr);
      if (reason) {
        throw sessionCheckErrorFor(
          {
            reason,
            errorMessage: navErr instanceof Error ? navErr.message : String(navErr),
            landedUrl: safePageUrl(page),
          },
          origin,
          navErr,
        );
      }
      throw navErr;
    }
    await waitForEBuilderPageToSettle(page);

    if (verifyAuth && (await detectLoginPage(page))) {
      throw sessionCheckErrorFor(
        { reason: 'redirected_to_login', landedUrl: safePageUrl(page) },
        origin,
      );
    }

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
            'iframe#contentFrame, iframe[name="contentFrame"]',
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
        if (meta?.innerHref && meta.innerHref !== 'about:blank') {
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
          args: arg,
          fs,
          path,
          os,
          eb: createNodeEbHelper(page),
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
      httpStatus,
      dialogs,
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
                'iframe#contentFrame, iframe[name="contentFrame"]',
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
