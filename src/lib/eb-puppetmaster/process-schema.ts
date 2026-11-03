import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import { injectEbHelper, waitForEBuilderPageToSettle } from './exec.js';
import { detectLoginPage, sessionCheckErrorFor } from './session-check.js';
import * as db from '../db.js';
import { envMap } from './index.js';

/** Cache key for an environment: accepts the short name ("us2") or the subdomain ("app-us2"). */
const envKey = (env: string) => envMap[env] ?? env;

export interface ProcessDataFieldSchema {
  id?: string | undefined;
  /** Field label as shown in e-Builder. */
  name: string;
  variableName?: string | undefined;
  type: string;
  permission?: string | undefined;
  unique?: boolean | undefined;
  /** Required on at least one page layout. */
  required?: boolean | undefined;
  options?: string[] | undefined;
  defaultValue?: string | undefined;
}

export interface ProcessWorkflowStepSchema {
  id?: string | undefined;
  name: string;
  type: string;
  actions: string[];
  actorLayout?: string | undefined;
  nonActorLayout?: string | undefined;
}

export interface ProcessLayoutSummary {
  id: string;
  name: string;
  inUse?: string | undefined;
  actorLayout?: string | undefined;
  nonActorLayout?: string | undefined;
}

export interface ProcessWorkflowSummary {
  id: string;
  name: string;
  projectAssignments?: string | undefined;
  datePublished?: string | undefined;
  lastUsed?: string | undefined;
}

export type LayoutFieldAccess = 'required' | 'editable' | 'readonly' | 'hidden';

export interface ProcessSchema {
  processId?: string | undefined;
  /** @deprecated Alias of processId (pre-0.2 name). */
  processTypeId?: string | undefined;
  name: string;
  prefix?: string | undefined;
  variableName?: string | undefined;
  type?: string | undefined;
  description?: string | undefined;
  projectAssignment?: string | undefined;
  active?: string | undefined;
  costIntegrated?: boolean | undefined;
  /** Steps of the account-default (or first) workflow. */
  workflowSteps: ProcessWorkflowStepSchema[];
  /** Name of the workflow `workflowSteps` came from. */
  workflow?: string | undefined;
  workflows?: ProcessWorkflowSummary[] | undefined;
  dataFields: ProcessDataFieldSchema[];
  layouts?: ProcessLayoutSummary[] | undefined;
  /** layout name → field label → access on that layout (fields not on a layout are "hidden"). */
  layoutMatrix: Record<string, Record<string, LayoutFieldAccess>>;
  warnings?: string[] | undefined;
  cachedAt?: string | undefined;
}

const cacheKey = (k: string) =>
  k
    .toLowerCase()
    .trim()
    .replace(/^\{|\}$/g, '');

/** True when a cached schema is the process the caller asked for (by name, prefix, variable name, or ID). */
function schemaMatches(schema: ProcessSchema, requested: string): boolean {
  const r = cacheKey(requested);
  return [schema.name, schema.prefix, schema.variableName, schema.processId, schema.processTypeId]
    .filter((k): k is string => Boolean(k))
    .some((k) => cacheKey(k) === r);
}

export function getCachedProcessSchema(
  env: string,
  account: string,
  processName: string,
): ProcessSchema | undefined {
  const json = db.getCachedSchema(envKey(env), account, 'process', cacheKey(processName));
  if (!json) return undefined;
  try {
    const schema = JSON.parse(json) as ProcessSchema;
    // Entries are stored under several identifiers; a key can collide (one process's name
    // equal to another's prefix). Only use the entry if it identifies this exact process,
    // or it was cached for this exact request (e.g. a unique partial name).
    const storedFor = (schema as ProcessSchema & { cachedFor?: string }).cachedFor;
    return schemaMatches(schema, processName) ||
      (storedFor && cacheKey(storedFor) === cacheKey(processName))
      ? schema
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Caches the schema under the requested identifier and under its name, prefix, variable name,
 * and ProcessID, so later lookups by any of them hit the cache.
 */
export function saveCachedProcessSchema(
  env: string,
  account: string,
  processName: string,
  schema: ProcessSchema,
): void {
  const payload = JSON.stringify({
    ...schema,
    cachedAt: new Date().toISOString(),
    cachedFor: processName,
  });
  const keys = new Set(
    [processName, schema.name, schema.prefix, schema.variableName, schema.processId]
      .filter((k): k is string => Boolean(k && k.trim()))
      .map(cacheKey),
  );
  for (const key of keys) db.setCachedSchema(envKey(env), account, 'process', key, payload);
}

/** Maximum number of page layouts whose XML is fetched for the layout matrix. */
const MAX_LAYOUTS = 30;

/**
 * Builds a process schema from the Setup pages (all read-only):
 * ManageProcesses → ManageDataFields / ManageLayouts / ManageWorkflows grids, plus
 * layout XML (field access per layout) and the default workflow's XML (steps and actions).
 *
 * `processName` matches the process name case-insensitively (exact match first, then a unique
 * partial match), or can be a ProcessID GUID.
 */
export async function fetchProcessSchema(options: {
  /** Overrides the environment URL (used by tests against a mock server). */
  origin?: string | undefined;
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
    browser ||
    (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900'], false, {
      allowDaemon: true,
    }));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: true });

    const origin = options.origin ?? `https://${env}.${baseurl}`;
    await page.goto(`${origin}/da2/Setup/Admin/Processes/ManageProcesses.aspx`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await waitForEBuilderPageToSettle(page);
    if (await detectLoginPage(page)) {
      throw sessionCheckErrorFor({ reason: 'redirected_to_login', landedUrl: page.url() }, origin);
    }
    await injectEbHelper(page);

    const result = await page.evaluate(
      async (target: string, maxLayouts: number) => {
        const eb = (window as any).eb;
        const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
        const guidOf = (href: string, param: string) =>
          (href.match(new RegExp(`${param}=\\{?([0-9a-f-]{36})`, 'i'))?.[1] ?? '').toLowerCase();

        /** Parses an e-Builder TableGrid (header row may be <td> sort links). */
        const parseGrid = (root: Document, idSuffix: string) => {
          const table = root.querySelector<HTMLTableElement>(`table[id$="${idSuffix}"]`);
          if (!table) return null;
          const rows = Array.from(table.rows);
          const headerRow = rows.find((r) => r.querySelector('th')) ?? rows[0];
          const headers = Array.from(headerRow?.cells ?? []).map(
            (c, i) => clean(c.textContent) || `Column_${i + 1}`,
          );
          return rows
            .filter((r) => r !== headerRow && r.cells.length >= Math.min(2, headers.length))
            .map((r) => ({
              cells: Object.fromEntries(headers.map((h, i) => [h, clean(r.cells[i]?.textContent)])),
              hrefs: Array.from(r.querySelectorAll('a[href]')).map(
                (a) => a.getAttribute('href') || '',
              ),
            }))
            .filter((r) => Object.values(r.cells).some(Boolean));
        };
        const fetchDoc = async (url: string) => {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
          return new DOMParser().parseFromString(await res.text(), 'text/html');
        };
        const xml = (text: string) => new DOMParser().parseFromString(text, 'text/xml');
        const child = (el: Element, tag: string) =>
          Array.from(el.children)
            .find((c) => c.tagName === tag)
            ?.textContent?.trim() ?? '';

        // 1. Find the process.
        const processes = (parseGrid(document, 'grdProcesses') ?? []).map((r) => ({
          ...r,
          id: r.hrefs.map((h) => guidOf(h, 'ProcessID')).find(Boolean) ?? '',
          name: r.cells['Name'] ?? '',
          prefix: r.cells['Prefix'] ?? '',
          variableName: r.cells['Variable Name'] ?? '',
        }));
        const t = target.trim().toLowerCase().replace(/[{}]/g, '');
        // ID or exact name first, then exact prefix / variable name, then a unique partial name.
        let matches = processes.filter((p) => p.id === t || p.name.toLowerCase() === t);
        if (matches.length === 0)
          matches = processes.filter(
            (p) => p.prefix.toLowerCase() === t || p.variableName.toLowerCase() === t,
          );
        if (matches.length === 0)
          matches = processes.filter((p) => p.name.toLowerCase().includes(t));
        if (matches.length !== 1) {
          return {
            error:
              matches.length === 0
                ? `Process "${target}" not found (${processes.length} processes in this account)`
                : `Process "${target}" is ambiguous: ${matches.map((m) => `${m.name} (${m.prefix})`).join(', ')}`,
          };
        }
        const proc = matches[0]!;
        const pid = proc.id;
        const warnings: string[] = [];

        // 2. Grids.
        const [fieldsDoc, layoutsDoc, workflowsDoc] = await Promise.all([
          fetchDoc(`/da2/Setup/Admin/Processes/ManageDataFields.aspx?ProcessID={${pid}}`),
          fetchDoc(`/da2/Setup/Admin/Processes/ManageLayouts.aspx?ProcessID={${pid}}`),
          fetchDoc(`/da2/Setup/Admin/Processes/ManageWorkflows.aspx?ProcessID={${pid}}`),
        ]);
        const dataFields = (parseGrid(fieldsDoc, 'dgFields') ?? [])
          .map((r) => ({
            name: r.cells['Label'] ?? '',
            variableName: r.cells['Variable Name'] || undefined,
            type: r.cells['Data Type'] || 'Unknown',
            permission: r.cells['Permission'] || undefined,
            unique: /^(yes|true)$/i.test(r.cells['Unique'] ?? '') || undefined,
          }))
          .filter((f) => f.name);
        const layouts = (parseGrid(layoutsDoc, 'grdLayouts') ?? [])
          .map((r) => ({
            id: r.hrefs.map((h) => guidOf(h, 'LayoutID')).find(Boolean) ?? '',
            name: r.cells['Layout Name'] ?? '',
            inUse: r.cells['In Use'] || undefined,
            actorLayout: r.cells['Actor Layout?'] || undefined,
            nonActorLayout: r.cells['Non-Actor Layout?'] || undefined,
          }))
          .filter((l) => l.id);
        const workflows = (parseGrid(workflowsDoc, 'grdWorkflows') ?? [])
          .map((r) => ({
            id: r.hrefs.map((h) => guidOf(h, 'WorkflowID')).find(Boolean) ?? '',
            name: r.cells['Workflow Name'] ?? '',
            projectAssignments: r.cells['Project Assignments'] || undefined,
            datePublished: r.cells['Date Published'] || undefined,
            lastUsed: r.cells['Last Used'] || undefined,
          }))
          .filter((w) => w.id);

        // 3. Layout XML → field access matrix.
        const layoutMatrix: Record<string, Record<string, string>> = {};
        const fieldIds: Record<string, string> = {};
        const requiredSomewhere = new Set<string>();
        if (layouts.length > maxLayouts) {
          warnings.push(`Only the first ${maxLayouts} of ${layouts.length} layouts were read`);
        }
        await Promise.all(
          layouts.slice(0, maxLayouts).map(async (l) => {
            try {
              const doc = xml(await eb.getLayoutXml(pid, l.id));
              const access: Record<string, string> = {};
              for (const f of Array.from(doc.getElementsByTagName('ebSectionField'))) {
                const name = child(f, 'DataFieldName');
                if (!name) continue;
                const id = child(f, 'DataFieldID');
                if (id && !/^0{8}-/.test(id)) fieldIds[name] = id;
                const required = child(f, 'IsRequired') === 'true';
                if (required) requiredSomewhere.add(name);
                access[name] = required
                  ? 'required'
                  : child(f, 'IsReadOnly') === 'true'
                    ? 'readonly'
                    : 'editable';
              }
              for (const f of dataFields) access[f.name] ??= 'hidden';
              layoutMatrix[l.name] = access;
            } catch (e: any) {
              warnings.push(`Layout "${l.name}" could not be read: ${e?.message ?? e}`);
            }
          }),
        );
        const layoutNameById = Object.fromEntries(layouts.map((l) => [l.id, l.name]));

        // 4. Default workflow → steps.
        const defaultWorkflow =
          workflows.find((w) => /account default/i.test(w.projectAssignments ?? '')) ??
          workflows[0];
        let workflowSteps: Array<Record<string, unknown>> = [];
        if (defaultWorkflow) {
          try {
            const wf = await eb.getWorkflowData(pid, defaultWorkflow.id);
            const doc = xml(wf.xml);
            workflowSteps = Array.from(doc.getElementsByTagName('ebStep')).map((s) => {
              const actor = (s.getAttribute('ActorLayoutID') ?? '').toLowerCase();
              const nonActor = (s.getAttribute('NonActorLayoutID') ?? '').toLowerCase();
              return {
                id: s.getAttribute('StepID') ?? undefined,
                name: s.getAttribute('Name') ?? '',
                type: s.getAttribute('StepType') ?? '',
                actions: Array.from(s.getElementsByTagName('ebAction')).map(
                  (a) => a.getAttribute('ButtonText') || a.getAttribute('Name') || '',
                ),
                actorLayout: layoutNameById[actor] || undefined,
                nonActorLayout: layoutNameById[nonActor] || undefined,
              };
            });
          } catch (e: any) {
            warnings.push(
              `Workflow "${defaultWorkflow.name}" could not be read: ${e?.message ?? e}`,
            );
          }
        }

        return {
          schema: {
            processId: pid,
            processTypeId: pid,
            name: proc.name,
            prefix: proc.cells['Prefix'] || undefined,
            variableName: proc.cells['Variable Name'] || undefined,
            description: proc.cells['Description'] || undefined,
            projectAssignment: proc.cells['Project Assignment'] || undefined,
            active: proc.cells['Active'] || undefined,
            workflow: defaultWorkflow?.name,
            workflowSteps,
            workflows,
            dataFields: dataFields.map((f) => ({
              ...(fieldIds[f.name] ? { id: fieldIds[f.name] } : {}),
              ...f,
              ...(requiredSomewhere.has(f.name) ? { required: true } : {}),
            })),
            layouts,
            layoutMatrix,
            ...(warnings.length ? { warnings } : {}),
          },
        };
      },
      processName,
      MAX_LAYOUTS,
    );

    if ('error' in result) throw new Error(result.error);
    const schema = JSON.parse(JSON.stringify(result.schema)) as ProcessSchema;
    saveCachedProcessSchema(env, account, processName, schema);
    return schema;
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export interface CompactProcessSchema {
  name: string;
  processId?: string | undefined;
  prefix?: string | undefined;
  /** "Label (Type)" with a trailing * when required on any layout. */
  fields: string[];
  /** "Step [Type]: Action1 | Action2". */
  steps: string[];
  layouts: string[];
}

/** Token-efficient projection of a process schema (for `process inspect --compact`). */
export function compactProcessSchema(schema: ProcessSchema): CompactProcessSchema {
  return {
    name: schema.name,
    processId: schema.processId ?? schema.processTypeId,
    prefix: schema.prefix,
    fields: schema.dataFields.map((f) => `${f.name} (${f.type})${f.required ? '*' : ''}`),
    steps: schema.workflowSteps.map(
      (s) => `${s.name} [${s.type}]${s.actions.length ? `: ${s.actions.join(' | ')}` : ''}`,
    ),
    layouts: schema.layouts?.map((l) => l.name) ?? Object.keys(schema.layoutMatrix),
  };
}
