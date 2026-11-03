import Papa from 'papaparse';
import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import { injectEbHelper, waitForEBuilderPageToSettle } from './exec.js';
import { detectLoginPage, sessionCheckErrorFor } from './session-check.js';
import {
  applyWizard,
  readWizard,
  saveWizardAs,
  startNewReportWizard,
  trackWizardDialogs,
  type WizardColumn,
  type WizardDateFilter,
  type WizardFilter,
  type WizardGrouping,
  type WizardOption,
  type WizardOrderedColumn,
  type WizardSort,
  type WizardStepData,
  type RawStepValues,
} from './report-wizard.js';
import * as db from '../db.js';

export interface ReportSummaryItem {
  id: string;
  name: string;
  description?: string | undefined;
  /** Folder path in the report tree, e.g. "Budget Reports" or "Dashboard - Admin / Sub". */
  category: string;
  folderId?: string | undefined;
  /** "custom" (wizard reports), "bi" (Business Intelligence), or "other". */
  type?: 'custom' | 'bi' | 'other' | undefined;
  url?: string | undefined;
  createdBy?: string | undefined;
}

/**
 * Portable custom-report definition, read from / replayed into the e-Builder report wizard.
 * Options keep both the server value and display text so they can be matched across accounts.
 */
export interface ReportConfig {
  version: 2;
  name: string;
  description?: string | undefined;
  /** Report folder name (as shown in the report tree). */
  folder?: string | undefined;
  /** Sharing on save. SelectedRoles is not supported; defaults to Personal. */
  access?: 'Personal' | 'AllUsers' | undefined;
  reportType: WizardOption;
  reportSubType: WizardOption;
  style: WizardOption;
  expandMultiValuedFields?: boolean | undefined;
  columns: WizardColumn[];
  columnOrder: WizardOrderedColumn[];
  aggregates: Array<{ column: string; functions: string[] }>;
  sorts: WizardSort[];
  /** Summary-style grouping levels. */
  groupings?: WizardGrouping[] | undefined;
  dateFilter?: WizardDateFilter | undefined;
  requireProjectSelection?: boolean | undefined;
  filters: WizardFilter[];
  /** Controls of wizard steps without a dedicated model (e.g. Summary/Matrix grouping). */
  extraSteps?: Record<string, RawStepValues> | undefined;
  /** Parts of the source report that could not be captured (e.g. formula columns). */
  warnings?: string[] | undefined;
}

export interface RunReportOptions {
  origin?: string | undefined;
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

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function normalizeReportId(reportId: string): string {
  const m = reportId.match(GUID);
  if (!m) throw new Error(`Invalid ReportID: ${reportId}`);
  return m[0].toLowerCase();
}

/** Opens an isolated page with the session cookies, runs `fn`, and always cleans up. */
/** Common options. `origin` overrides the environment URL (used by tests against a mock server). */
interface SessionPageOptions {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  origin?: string | undefined;
}

async function withSessionPage<T>(
  options: SessionPageOptions,
  fn: (page: puppeteer.Page, origin: string) => Promise<T>,
  pageOptions: { blockAssets?: boolean } = { blockAssets: true },
): Promise<T> {
  const browserInstance =
    options.browser ||
    (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900'], false, {
      allowDaemon: true,
    }));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;
  try {
    await context.setCookie(...options.cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, pageOptions);
    // Wizard validation alerts must never block automation; they are recorded for errors.
    trackWizardDialogs(page);
    return await fn(page, options.origin ?? `https://${options.env}.${baseurl}`);
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function gotoAuthenticated(page: puppeteer.Page, url: string, origin: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForEBuilderPageToSettle(page);
  if (await detectLoginPage(page)) {
    throw sessionCheckErrorFor({ reason: 'redirected_to_login', landedUrl: page.url() }, origin);
  }
}

/** Parses the report tree on /da2/Reports/index.aspx (modus-tree-view). Runs in the page. */
async function readReportTree(page: puppeteer.Page): Promise<ReportSummaryItem[]> {
  return await page.evaluate(() => {
    const items: Array<{
      id: string;
      name: string;
      description?: string;
      category: string;
      folderId?: string;
      type: 'custom' | 'bi' | 'other';
      url: string;
    }> = [];
    const tree = document.querySelector('#modusTreeView, modus-tree-view');
    if (!tree) return items;
    const labelOf = (item: Element) =>
      (item.querySelector(':scope > [slot="label"]')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    tree.querySelectorAll('modus-tree-view-item').forEach((item) => {
      const link = item.querySelector<HTMLAnchorElement>(
        ':scope > [slot="label"] a[href*="ReportID="]',
      );
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const id = (href.match(/ReportID=\{?([0-9a-f-]{36})/i)?.[1] ?? '').toLowerCase();
      if (!id) return;
      const folders: string[] = [];
      let folderId: string | undefined;
      let parent = item.parentElement?.closest('modus-tree-view-item');
      while (parent) {
        folders.unshift(labelOf(parent));
        folderId ??= parent.getAttribute('node-id') ?? undefined;
        parent = parent.parentElement?.closest('modus-tree-view-item') ?? null;
      }
      const description =
        item.querySelector(':scope > [slot="label"] .report-description')?.textContent?.trim() ||
        undefined;
      items.push({
        id,
        name: (link.textContent || '').trim(),
        ...(description ? { description } : {}),
        category: folders.join(' / ') || 'Unfiled',
        ...(folderId ? { folderId } : {}),
        type: /ReportResults\.aspx/i.test(href)
          ? 'custom'
          : /BusinessIntelligence|BIReports/i.test(href)
            ? 'bi'
            : 'other',
        url: href,
      });
    });
    return items;
  });
}

export async function fetchReportCatalog(options: {
  origin?: string | undefined;
  env: Environment;
  cookies: puppeteer.Cookie[];
  account?: string | undefined;
  browser?: puppeteer.Browser | undefined;
  useCache?: boolean | undefined;
}): Promise<ReportSummaryItem[]> {
  const { env, account = '', useCache = true } = options;

  if (useCache) {
    const cached = getCachedReportCatalog(env, account);
    if (cached) return cached;
  }

  const reports = await withSessionPage(options, async (page, origin) => {
    await gotoAuthenticated(page, `${origin}/da2/Reports/index.aspx`, origin);
    return await readReportTree(page);
  });

  saveCachedReportCatalog(env, account, reports);
  return reports;
}

function wizardDataToConfig(
  data: WizardStepData,
  meta: { name: string; description?: string | undefined; folder?: string | undefined },
): ReportConfig {
  if (!data.DataType) throw new Error('Report wizard did not expose the data type step');
  const warnings: string[] = [];
  const formulas = data.Columns?.formulaColumns ?? [];
  if (formulas.length) warnings.push(`Formula columns are not exported: ${formulas.join(', ')}`);
  return {
    version: 2,
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.folder ? { folder: meta.folder } : {}),
    reportType: data.DataType.reportType,
    reportSubType: data.DataType.reportSubType,
    style: data.Style?.style ?? { value: '1', text: 'Tabular' },
    expandMultiValuedFields: data.Columns?.expandMultiValuedFields ?? false,
    columns: data.Columns?.columns ?? [],
    columnOrder: data.ReorderColumns?.columnOrder ?? [],
    aggregates: (data.Aggregate?.aggregates ?? []).filter((a) => a.functions.length > 0),
    sorts: data.ReorderColumns?.sorts ?? [],
    ...(data.Grouping?.groupings.length ? { groupings: data.Grouping.groupings } : {}),
    ...(data.Criteria?.dateFilter ? { dateFilter: data.Criteria.dateFilter } : {}),
    requireProjectSelection: data.Criteria?.requireProjectSelection ?? false,
    filters: data.Criteria?.filters ?? [],
    ...(data.raw && Object.keys(data.raw).length ? { extraSteps: data.raw } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function configToWizardData(config: ReportConfig): WizardStepData {
  return {
    DataType: { reportType: config.reportType, reportSubType: config.reportSubType },
    Style: { style: config.style },
    Columns: {
      columns: config.columns,
      expandMultiValuedFields: Boolean(config.expandMultiValuedFields),
      formulaColumns: [],
    },
    Aggregate: { aggregates: config.aggregates ?? [] },
    ReorderColumns: { columnOrder: config.columnOrder ?? [], sorts: config.sorts ?? [] },
    Grouping: { groupings: config.groupings ?? [] },
    Criteria: {
      dateFilter: config.dateFilter,
      requireProjectSelection: Boolean(config.requireProjectSelection),
      filters: config.filters ?? [],
    },
    ...(config.extraSteps ? { raw: config.extraSteps } : {}),
  };
}

/** Validates a parsed config file, rejecting the pre-0.2 format that never matched e-Builder. */
export function assertReportConfig(value: unknown): asserts value is ReportConfig {
  const c = value as Partial<ReportConfig> | null;
  if (!c || typeof c !== 'object') throw new Error('Report config must be a JSON object');
  if (c.version !== 2 || !c.reportType || !c.reportSubType || !Array.isArray(c.columns)) {
    throw new Error(
      'Unsupported report config format. Re-export it with this version of eb-cli (`eb reports export-config`).',
    );
  }
  if (!c.name) throw new Error('Report config is missing "name"');
}

/**
 * Reads a custom report's definition by walking its wizard with Next (never saving).
 * Name, description, and folder come from the report tree.
 */
export async function exportReportConfig(options: {
  origin?: string | undefined;
  env: Environment;
  cookies: puppeteer.Cookie[];
  reportId: string;
  browser?: puppeteer.Browser | undefined;
}): Promise<ReportConfig> {
  const reportId = normalizeReportId(options.reportId);
  return await withSessionPage(options, async (page, origin) => {
    await gotoAuthenticated(page, `${origin}/da2/Reports/index.aspx`, origin);
    const meta = (await readReportTree(page)).find((r) => r.id === reportId);
    if (meta && meta.type !== 'custom') {
      throw new Error(
        `Report "${meta.name}" is a ${meta.type} report; only custom reports can be exported`,
      );
    }

    await gotoAuthenticated(
      page,
      `${origin}/da2/Reports/AddEditReport.aspx?ReportID=${reportId}`,
      origin,
    );
    const { data } = await readWizard(page);
    const name =
      meta?.name ??
      (await page.evaluate(() =>
        document.querySelector('[id$=lblReportName]')?.textContent?.trim(),
      )) ??
      `Report ${reportId}`;
    const folderName = meta?.category?.split(' / ').pop();
    const personal = !folderName || /^My Personal Reports$/i.test(folderName);
    const config = wizardDataToConfig(data, {
      name,
      description: meta?.description,
      folder: personal ? undefined : folderName,
    });
    config.access = personal ? 'Personal' : 'AllUsers';
    if (!personal) {
      (config.warnings ??= []).push(
        'Shared reports are re-created as available to all users; role-restricted access is not copied',
      );
    }
    return config;
  });
}

/**
 * Creates a new custom report by replaying a config through the wizard and saving it.
 * Every wizard control is set explicitly because unsaved wizard state persists server-side.
 */
export async function createReportFromConfig(options: {
  origin?: string | undefined;
  env: Environment;
  cookies: puppeteer.Cookie[];
  config: ReportConfig;
  browser?: puppeteer.Browser | undefined;
}): Promise<{
  success: boolean;
  reportId?: string | undefined;
  url?: string | undefined;
  warnings: string[];
}> {
  const { config } = options;
  assertReportConfig(config);

  return await withSessionPage(options, async (page, origin) => {
    await gotoAuthenticated(page, `${origin}/da2/Reports/index.aspx`, origin);
    await startNewReportWizard(page, origin);
    const { warnings } = await applyWizard(page, configToWizardData(config));
    warnings.push(
      ...(await saveWizardAs(page, {
        name: config.name,
        description: config.description,
        folder: config.folder,
        access: config.access,
      })),
    );

    // Find the new report's id in the tree (newest match wins if names repeat).
    let reportId = page
      .url()
      .match(/ReportID=\{?([0-9a-f-]{36})/i)?.[1]
      ?.toLowerCase();
    if (!reportId) {
      await gotoAuthenticated(page, `${origin}/da2/Reports/index.aspx`, origin);
      const matches = (await readReportTree(page)).filter((r) => r.name === config.name);
      reportId = matches[matches.length - 1]?.id;
    }
    return {
      success: true,
      reportId,
      url: reportId ? `${origin}/da2/Reports/ReportResults.aspx?ReportID=${reportId}` : page.url(),
      warnings: [...new Set(warnings)],
    };
  });
}

/**
 * Runs a custom report and returns its rows. Data comes from the report's CSV export, so all
 * rows are available regardless of on-screen paging; `limit` caps the rows returned.
 */
export async function runReport(options: RunReportOptions): Promise<RunReportResult> {
  const reportId = normalizeReportId(options.reportId);
  const limit = options.limit ?? 50;

  return await withSessionPage(options, async (page, origin) => {
    await gotoAuthenticated(
      page,
      `${origin}/da2/Reports/ReportResults.aspx?ReportID=${reportId}`,
      origin,
    );
    const reportName =
      (await page.evaluate(
        () => document.querySelector('[id$="lblReportName"]')?.textContent?.trim() || '',
      )) || 'Report';
    await injectEbHelper(page);
    const csv = (await page.evaluate(
      (id: string) => (window as any).eb.exportReportCsv(id),
      reportId,
    )) as string;

    const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: true,
    });
    const headers = parsed.meta.fields ?? [];
    return {
      reportId,
      reportName,
      headers,
      totalRows: parsed.data.length,
      rows: limit > 0 ? parsed.data.slice(0, limit) : parsed.data,
    };
  });
}
