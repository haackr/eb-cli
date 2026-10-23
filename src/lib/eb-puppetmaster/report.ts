import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import * as db from '../db.js';

export interface ReportSummaryItem {
  id: string;
  name: string;
  description?: string | undefined;
  category: string;
  type?: string | undefined;
  createdBy?: string | undefined;
}

export interface ReportConfigColumn {
  field: string;
  header: string;
  format?: string | undefined;
}

export interface ReportConfigFilter {
  field: string;
  operator: string;
  value: string;
  logic?: 'AND' | 'OR' | undefined;
}

export interface ReportConfig {
  name: string;
  description?: string | undefined;
  category: string;
  dataSource: string;
  columns: ReportConfigColumn[];
  groupings?: string[] | undefined;
  sorts?: Array<{ field: string; direction: 'ASC' | 'DESC' }> | undefined;
  filters?: ReportConfigFilter[] | undefined;
  summaries?: Array<{ field: string; calculation: 'SUM' | 'AVG' | 'COUNT' }> | undefined;
}

export interface RunReportOptions {
  env: Environment;
  cookies: puppeteer.Cookie[];
  reportId: string;
  limit?: number | undefined;
  browser?: puppeteer.Browser | undefined;
}

export interface RunReportResult {
  reportId: string;
  reportName: string;
  headers: string[];
  totalRows: number;
  rows: Record<string, string>[];
}

export function getCachedReportCatalog(
  env: string,
  account: string,
): ReportSummaryItem[] | undefined {
  const json = db.getCachedSchema(env, account, 'report_catalog', 'all');
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ReportSummaryItem[];
  } catch {
    return undefined;
  }
}

export function saveCachedReportCatalog(
  env: string,
  account: string,
  reports: ReportSummaryItem[],
): void {
  db.setCachedSchema(env, account, 'report_catalog', 'all', JSON.stringify(reports));
}

export async function fetchReportCatalog(options: {
  env: Environment;
  cookies: puppeteer.Cookie[];
  account?: string | undefined;
  browser?: puppeteer.Browser | undefined;
  useCache?: boolean | undefined;
}): Promise<ReportSummaryItem[]> {
  const { env, cookies, account = '', browser, useCache = true } = options;

  if (useCache) {
    const cached = getCachedReportCatalog(env, account);
    if (cached) return cached;
  }

  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900']));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: true });

    const origin = `https://${env}.${baseurl}`;
    const targetUrl = `${origin}/da2/Reports/ReportsView.aspx`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const reports = await page.evaluate(() => {
      const getDoc = () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe && iframe.contentDocument) return iframe.contentDocument;
        } catch {}
        return document;
      };

      const doc = getDoc();
      const items: ReportSummaryItem[] = [];
      const trs = Array.from(
        doc.querySelectorAll('table.rgMasterTable tbody tr, table.grid tbody tr, table tr'),
      );

      for (const tr of trs) {
        const link = tr.querySelector('a[href*="ReportID="], a[href*="reportid="], a');
        if (!link) continue;
        const href = link.getAttribute('href') || '';
        const match = href.match(/ReportID=([a-f0-9-]+)/i);
        if (!match || !match[1]) continue;

        const id = match[1];
        const name = link.textContent?.trim() || 'Untitled Report';
        const tds = Array.from(tr.querySelectorAll('td'));

        let category = 'Standard';
        let description: string | undefined;

        if (tds.length >= 3) {
          category = tds[1]?.textContent?.trim() || category;
          description = tds[2]?.textContent?.trim() || undefined;
        }

        items.push({
          id,
          name,
          category,
          description,
        });
      }

      return items;
    });

    saveCachedReportCatalog(env, account, reports);
    return reports;
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function exportReportConfig(options: {
  env: Environment;
  cookies: puppeteer.Cookie[];
  reportId: string;
  browser?: puppeteer.Browser | undefined;
}): Promise<ReportConfig> {
  const { env, cookies, reportId, browser } = options;

  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900']));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: true });

    const origin = `https://${env}.${baseurl}`;
    const designerUrl = `${origin}/da2/Reports/ReportDesigner.aspx?ReportID=${reportId}`;

    await page.goto(designerUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const config = await page.evaluate((id) => {
      const getDoc = () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe && iframe.contentDocument) return iframe.contentDocument;
        } catch {}
        return document;
      };

      const doc = getDoc();
      const nameInput = doc.querySelector<HTMLInputElement>(
        'input[id*="tbReportName"], input[name*="ReportName"], input[id*="txtName"]',
      );
      const descInput = doc.querySelector<HTMLTextAreaElement>(
        'textarea[id*="tbDescription"], textarea[name*="Description"], textarea[id*="txtDescription"]',
      );
      const categorySelect = doc.querySelector<HTMLSelectElement>(
        'select[id*="ddlCategory"], select[name*="Category"]',
      );
      const moduleSelect = doc.querySelector<HTMLSelectElement>(
        'select[id*="ddlModule"], select[name*="Module"], select[id*="ddlDataSource"]',
      );

      const name = nameInput?.value?.trim() || `Report_${id}`;
      const description = descInput?.value?.trim() || undefined;
      const category = categorySelect?.selectedOptions[0]?.text?.trim() || 'Custom';
      const dataSource = moduleSelect?.selectedOptions[0]?.text?.trim() || 'Processes';

      const columns: Array<{ field: string; header: string }> = [];
      const colItems = doc.querySelectorAll('.column-item, .selected-column, tr[id*="col"]');
      colItems.forEach((col) => {
        const text = col.textContent?.trim();
        if (text) {
          columns.push({ field: text, header: text });
        }
      });

      return {
        name,
        description,
        category,
        dataSource,
        columns:
          columns.length > 0 ? columns : [{ field: 'Item Identifier', header: 'Item Identifier' }],
      };
    }, reportId);

    return config;
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function createReportFromConfig(options: {
  env: Environment;
  cookies: puppeteer.Cookie[];
  config: ReportConfig;
  browser?: puppeteer.Browser | undefined;
}): Promise<{ success: boolean; reportId?: string | undefined; url?: string | undefined }> {
  const { env, cookies, config, browser } = options;

  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900']));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: true });

    const origin = `https://${env}.${baseurl}`;
    const newReportUrl = `${origin}/da2/Reports/ReportDesigner.aspx`;

    await page.goto(newReportUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const created = await page.evaluate((cfg) => {
      const getDoc = () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe && iframe.contentDocument) return iframe.contentDocument;
        } catch {}
        return document;
      };

      const doc = getDoc();
      const nameInput = doc.querySelector<HTMLInputElement>(
        'input[id*="tbReportName"], input[name*="ReportName"], input[id*="txtName"]',
      );
      if (nameInput) {
        nameInput.value = cfg.name;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const descInput = doc.querySelector<HTMLTextAreaElement>(
        'textarea[id*="tbDescription"], textarea[name*="Description"], textarea[id*="txtDescription"]',
      );
      if (descInput && cfg.description) {
        descInput.value = cfg.description;
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      return {
        submitted: Boolean(nameInput),
      };
    }, config);

    return {
      success: created.submitted,
      url: typeof page.url === 'function' ? page.url() : newReportUrl,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function runReport(options: RunReportOptions): Promise<RunReportResult> {
  const { env, cookies, reportId, limit = 50, browser } = options;

  const browserInstance =
    browser || (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900']));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: true });

    const origin = `https://${env}.${baseurl}`;
    const reportUrl = `${origin}/da2/Reports/ReportViewer.aspx?ReportID=${reportId}`;

    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const data = await page.evaluate((maxRows) => {
      const getDoc = () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe && iframe.contentDocument) return iframe.contentDocument;
        } catch {}
        return document;
      };

      const doc = getDoc();
      const reportTitle =
        doc.querySelector('.report-title, h1, #lblReportTitle')?.textContent?.trim() || 'Report';

      const tbl = doc.querySelector('table.rgMasterTable, table.report-grid, table.grid, table');
      if (!tbl) {
        return { reportTitle, headers: [], totalRows: 0, rows: [] };
      }

      const headers: string[] = [];
      tbl.querySelectorAll('thead th, tr.rgHeader th, tr:first-child th').forEach((th) => {
        const text = (th.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) headers.push(text);
      });

      const rows: Record<string, string>[] = [];
      const trs = Array.from(tbl.querySelectorAll('tbody tr, tr.rgRow, tr.rgAltRow')).filter(
        (tr) => !tr.querySelector('th'),
      );

      const cap = Math.min(trs.length, maxRows);
      for (let i = 0; i < cap; i++) {
        const tr = trs[i];
        if (!tr) continue;
        const tds = tr.querySelectorAll('td');
        const rowObj: Record<string, string> = {};
        tds.forEach((td, idx) => {
          const header = headers[idx] || `Column_${idx + 1}`;
          rowObj[header] = (td.textContent || '').replace(/\s+/g, ' ').trim();
        });
        if (Object.keys(rowObj).length > 0) {
          rows.push(rowObj);
        }
      }

      return {
        reportTitle,
        headers,
        totalRows: trs.length,
        rows,
      };
    }, limit);

    return {
      reportId,
      reportName: data.reportTitle,
      headers: data.headers,
      totalRows: data.totalRows,
      rows: data.rows,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
