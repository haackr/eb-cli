import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import * as db from '../db.js';

export interface ProcessDataFieldSchema {
  id?: string | undefined;
  name: string;
  type: string;
  required?: boolean | undefined;
  options?: string[] | undefined;
  defaultValue?: string | undefined;
}

export interface ProcessWorkflowStepSchema {
  id?: string | undefined;
  name: string;
  type: string;
  actions: string[];
}

export interface ProcessSchema {
  processTypeId?: string | undefined;
  name: string;
  prefix?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  costIntegrated?: boolean | undefined;
  workflowSteps: ProcessWorkflowStepSchema[];
  dataFields: ProcessDataFieldSchema[];
  layoutMatrix: Record<string, Record<string, 'required' | 'editable' | 'readonly' | 'hidden'>>;
  cachedAt?: string | undefined;
}

export function getCachedProcessSchema(
  env: string,
  account: string,
  processName: string,
): ProcessSchema | undefined {
  const json = db.getCachedSchema(env, account, 'process', processName.toLowerCase().trim());
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ProcessSchema;
  } catch {
    return undefined;
  }
}

export function saveCachedProcessSchema(
  env: string,
  account: string,
  processName: string,
  schema: ProcessSchema,
): void {
  const normalizedKey = processName.toLowerCase().trim();
  const payload = {
    ...schema,
    cachedAt: new Date().toISOString(),
  };
  db.setCachedSchema(env, account, 'process', normalizedKey, JSON.stringify(payload));
}

export function parseProcessSchemaFromHtml(_html: {
  processTypeHtml?: string | undefined;
  dataFieldsHtml?: string | undefined;
  pageLayoutHtml?: string | undefined;
}): ProcessSchema {
  // Pure parser for HTML structures to support mock testing and offline processing
  const schema: ProcessSchema = {
    name: 'Process',
    workflowSteps: [],
    dataFields: [],
    layoutMatrix: {},
  };

  return schema;
}

export async function fetchProcessSchema(options: {
  env: Environment;
  cookies: puppeteer.Cookie[];
  processName: string;
  account?: string | undefined;
  browser?: puppeteer.Browser | undefined;
  useCache?: boolean | undefined;
}): Promise<ProcessSchema> {
  const { env, cookies, processName, account = '', browser, useCache = true } = options;

  if (useCache) {
    const cached = getCachedProcessSchema(env, account, processName);
    if (cached) {
      return cached;
    }
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
    const targetUrl = `${origin}/da2/Setup/Processes/ProcessTypesView.aspx`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const extracted = await page.evaluate((targetName) => {
      const getDoc = () => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
            return iframe.contentDocument;
          }
        } catch {}
        return document;
      };

      const doc = getDoc();
      const normalize = (s: string | null | undefined) => (s || '').toLowerCase().trim();
      const rows = Array.from(
        doc.querySelectorAll('table.rgMasterTable tbody tr, table.grid tbody tr, table tr'),
      );

      let matchedRow: Element | null = null;
      let processTypeId = '';
      let prefix = '';
      let desc = '';

      for (const row of rows) {
        const link = row.querySelector('a');
        const text = link?.textContent?.trim() || '';
        if (
          normalize(text) === normalize(targetName) ||
          (text && normalize(targetName).includes(normalize(text)))
        ) {
          matchedRow = row;
          const href = link?.getAttribute('href') || '';
          const match = href.match(/ProcessTypeID=([a-f0-9-]+)/i);
          if (match && match[1]) {
            processTypeId = match[1];
          }
          const cells = row.querySelectorAll('td');
          if (cells.length > 2) {
            prefix = cells[1]?.textContent?.trim() || '';
            desc = cells[2]?.textContent?.trim() || '';
          }
          break;
        }
      }

      return {
        found: Boolean(matchedRow),
        processTypeId,
        prefix,
        desc,
      };
    }, processName);

    const schema: ProcessSchema = {
      name: processName,
      processTypeId: extracted.processTypeId || undefined,
      prefix: extracted.prefix || undefined,
      description: extracted.desc || undefined,
      workflowSteps: [],
      dataFields: [],
      layoutMatrix: {},
    };

    if (extracted.processTypeId) {
      // Fetch Data Fields
      const dataFieldsUrl = `${origin}/da2/Setup/Processes/DataFieldsView.aspx?ProcessTypeID=${extracted.processTypeId}`;
      await page.goto(dataFieldsUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

      const fields = await page.evaluate(() => {
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
        const trs = Array.from(
          doc.querySelectorAll('table.rgMasterTable tbody tr, table.grid tbody tr, table tr'),
        );
        const result: Array<{ name: string; type: string; required?: boolean }> = [];

        for (const tr of trs) {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 2) {
            const name = tds[0]?.textContent?.trim() || '';
            const type = tds[1]?.textContent?.trim() || 'Text';
            const reqText = tds[2]?.textContent?.trim() || '';
            if (name && name !== 'Field Name') {
              result.push({
                name,
                type,
                required: reqText.toLowerCase().includes('yes') || reqText.includes('*'),
              });
            }
          }
        }
        return result;
      });

      schema.dataFields = fields;
    }

    saveCachedProcessSchema(env, account, processName, schema);
    return schema;
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
