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

export interface ProcessDataFieldAssignment {
  /** Label of the field the action sets. */
  field: string;
  fieldId?: string | undefined;
  /** e-Builder formula; `{DataField.<guid>}` references are rewritten to `[Field Label]` when known. */
  expression: string;
}

export interface ProcessWorkflowActionSchema {
  id?: string | undefined;
  /** Button text (falls back to the action name). */
  name: string;
  /** Name of the step this action leads to (absent when the action is not connected). */
  to?: string | undefined;
  toStepId?: string | undefined;
  /** On a Conditional step: the branch of the step's `condition` this action follows. */
  conditionResult?: boolean | undefined;
  /** Process status the action sets (omitted when it does not change the status). */
  status?: string | undefined;
  requireComments?: boolean | undefined;
  /** Roles offered as additional actors / non-actors by this action. */
  additionalRoles?: string[] | undefined;
  /** Data field assignments run when the action is taken, in order. */
  assignments?: ProcessDataFieldAssignment[] | undefined;
}

export interface ProcessWorkflowStepSchema {
  id?: string | undefined;
  name: string;
  type: string;
  /** Action labels (kept for compatibility; see `actionDetails`). */
  actions: string[];
  /** Actions with their target step, branch, status, and field assignments. */
  actionDetails?: ProcessWorkflowActionSchema[] | undefined;
  /** Conditional steps: the branch expression (field references rewritten like assignments). */
  condition?: string | undefined;
  /** Who acts on the step: role names (or role IDs), or "person who took action at <step>". */
  actors?: string[] | undefined;
  /** Roles notified when the step starts. */
  notifyRoles?: string[] | undefined;
  /** Spawn steps: the process that is spawned (name when known, else ProcessID). */
  spawnProcess?: string | undefined;
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

/**
 * Bumped when fetchProcessSchema starts collecting new data, so cached schemas from older
 * versions are refetched instead of silently missing it.
 */
export const PROCESS_SCHEMA_VERSION = 2;

export interface ProcessSchema {
  schemaVersion?: number | undefined;
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
    if (schema.schemaVersion !== PROCESS_SCHEMA_VERSION) return undefined;
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
    schemaVersion: PROCESS_SCHEMA_VERSION,
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
      async (target: string, maxLayouts: number, schemaVersion: number) => {
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

        // 4. Default workflow → steps, connectors (action → next step), and field assignments.
        const defaultWorkflow =
          workflows.find((w) => /account default/i.test(w.projectAssignments ?? '')) ??
          workflows[0];
        let workflowSteps: Array<Record<string, unknown>> = [];
        if (defaultWorkflow) {
          try {
            const wf = await eb.getWorkflowData(pid, defaultWorkflow.id);
            const doc = xml(wf.xml);
            const isNullGuid = (g: string | null | undefined) => !g || /^[0-]+$/.test(g);
            const lower = (g: string | null | undefined) =>
              (g ?? '').toLowerCase().replace(/[{}]/g, '');
            const stepEls = Array.from(doc.getElementsByTagName('ebStep'));
            const stepNameById: Record<string, string> = Object.fromEntries(
              stepEls.map((s) => [lower(s.getAttribute('StepID')), s.getAttribute('Name') ?? '']),
            );
            const connectorByAction: Record<string, string> = {};
            for (const c of Array.from(doc.getElementsByTagName('ebConnector'))) {
              const to = lower(c.getAttribute('ToStepID'));
              if (!isNullGuid(to)) connectorByAction[lower(c.getAttribute('ActionID'))] = to;
            }
            // Field GUID → label, from the layouts plus the assignment targets themselves.
            const fieldNameById: Record<string, string> = {};
            for (const [name, id] of Object.entries(fieldIds)) fieldNameById[lower(id)] = name;
            for (const a of Array.from(doc.getElementsByTagName('ebDataFieldAssignment'))) {
              const id = lower(a.getAttribute('DataFieldID'));
              const name = a.getAttribute('DataFieldName');
              if (!isNullGuid(id) && name) fieldNameById[id] ??= name;
            }
            const readable = (expr: string) =>
              expr.replace(/\{DataField\.\{?([0-9a-f-]{36})\}?\}/gi, (m, id: string) =>
                fieldNameById[id.toLowerCase()] ? `[${fieldNameById[id.toLowerCase()]}]` : m,
              );
            const roleLabel = (el: Element) =>
              el.getAttribute('RoleName') || `role ${lower(el.getAttribute('RoleID'))}`;
            const kids = (el: Element, container: string, tag: string) =>
              Array.from(el.children)
                .filter((c) => c.tagName === container)
                .flatMap((c) => Array.from(c.children).filter((k) => k.tagName === tag));
            const processNameById: Record<string, string> = Object.fromEntries(
              processes.map((p) => [p.id, p.name]),
            );

            workflowSteps = stepEls.map((s) => {
              const actor = lower(s.getAttribute('ActorLayoutID'));
              const nonActor = lower(s.getAttribute('NonActorLayoutID'));
              const type = s.getAttribute('StepType') ?? '';
              const actionEls = kids(s, 'Actions', 'ebAction');
              const actionDetails = actionEls.map((a) => {
                const toStepId = connectorByAction[lower(a.getAttribute('ActionID'))];
                const status = a.getAttribute('Status');
                const assignments = kids(a, 'DataFieldAssignments', 'ebDataFieldAssignment').map(
                  (f) => {
                    const fieldId = lower(f.getAttribute('DataFieldID'));
                    return {
                      field:
                        f.getAttribute('DataFieldName') ||
                        fieldNameById[fieldId] ||
                        f.getAttribute('AssignToFieldName') ||
                        fieldId,
                      ...(isNullGuid(fieldId) ? {} : { fieldId }),
                      expression: readable(f.getAttribute('AssignmentExpression') ?? ''),
                    };
                  },
                );
                const additionalRoles = kids(a, 'ActionRoles', 'ebActionRole').map(roleLabel);
                return {
                  id: lower(a.getAttribute('ActionID')) || undefined,
                  name: a.getAttribute('ButtonText') || a.getAttribute('Name') || '',
                  to: toStepId ? stepNameById[toStepId] || toStepId : undefined,
                  toStepId,
                  conditionResult:
                    type === 'Conditional'
                      ? a.getAttribute('ConditionalBranchExpressionValue') === 'true'
                      : undefined,
                  status: status && status !== 'NotAssigned' ? status : undefined,
                  requireComments: a.getAttribute('RequireComments') === 'true' || undefined,
                  additionalRoles: additionalRoles.length ? additionalRoles : undefined,
                  assignments: assignments.length ? assignments : undefined,
                };
              });
              const actors = kids(s, 'Actors', 'ebActor').map((a) => {
                const inStep = lower(a.getAttribute('ParticipantInStepID'));
                if (
                  a.getAttribute('ParticipantType') === 'PersonTakingAction' &&
                  !isNullGuid(inStep)
                )
                  return `person who took action at ${stepNameById[inStep] || inStep}`;
                return roleLabel(a);
              });
              const notifyRoles = kids(s, 'NotifyRoles', 'ebNotifyRole').map(roleLabel);
              const spawnId = lower(s.getAttribute('SpawnProcessID'));
              const condition = s.getAttribute('ConditionalBranchExpression');
              return {
                id: s.getAttribute('StepID') ?? undefined,
                name: s.getAttribute('Name') ?? '',
                type,
                actions: actionDetails.map((a) => a.name),
                actionDetails,
                condition: condition ? readable(condition) : undefined,
                actors: actors.length ? actors : undefined,
                notifyRoles: notifyRoles.length ? notifyRoles : undefined,
                spawnProcess: isNullGuid(spawnId) ? undefined : processNameById[spawnId] || spawnId,
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
            schemaVersion,
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
      PROCESS_SCHEMA_VERSION,
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
  /**
   * "Step [Type]: Action1 -> Next | Action2 -> Other {sets Field A, Field B}".
   * Conditional steps read "Step [Conditional: <expression>]: true -> X | false -> Y".
   */
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
    steps: schema.workflowSteps.map((s) => {
      const actions = s.actionDetails
        ? s.actionDetails.map((a) => {
            const sets = a.assignments?.length
              ? ` {sets ${a.assignments.map((f) => f.field).join(', ')}}`
              : '';
            return `${a.name}${a.to ? ` -> ${a.to}` : ''}${sets}`;
          })
        : s.actions;
      const type = s.condition ? `${s.type}: ${s.condition}` : s.type;
      const spawn = s.spawnProcess ? ` (spawns ${s.spawnProcess})` : '';
      return `${s.name} [${type}]${spawn}${actions.length ? `: ${actions.join(' | ')}` : ''}`;
    }),
    layouts: schema.layouts?.map((l) => l.name) ?? Object.keys(schema.layoutMatrix),
  };
}
