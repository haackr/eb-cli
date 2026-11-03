/**
 * Working with process instances (not process configuration): list what can be started in a
 * project, list instances, view an instance, start one, set fields, and take workflow actions.
 *
 * Pages (verified on US2):
 * - /da2/Processes/ProjectProcesses.aspx?PortalID={id}: startable processes come from the page's
 *   getSelectProcessModalProcessOptions(); open instances from its modus-table `data`.
 * - /da2/Processes/StartProcess.aspx?PortalID={id}&ProcessID={id}: start form (txtSubject when
 *   the workflow allows a manual subject; btnPostForm = Submit, btnSaveDraft = Save Draft).
 * - /da2/Processes/InstanceDetails.aspx?InstanceID={id}: lbl* header, ddlActions + btnTakeAction,
 *   btnSave for field edits.
 * - /da2/Controls/AjaxService.asmx/GetProjects: all projects (needs the page's security token).
 */
import { waitForEBuilderPageToSettle } from './exec.js';
import {
  checkFormFields,
  readFormErrors,
  readFormFields,
  writeFormFields,
  type FieldInputValue,
  type FieldWriteResult,
  type ProcessField,
} from './process-form.js';
import { gotoAuthenticated, withSessionPage, type SessionPageOptions } from './session-page.js';

export type { ProcessField, FieldInputValue, FieldWriteResult } from './process-form.js';

const GUID = /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i;
const ID = 'ctl00_contentSection_';

export function parseGuid(value: string): string | null {
  return value.match(GUID)?.[1]?.toLowerCase() ?? null;
}

export class ProcessInstanceError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProcessInstanceError';
  }
}

export interface ProjectRef {
  id: string;
  name: string;
  number?: string | undefined;
}

export interface StartableProcess {
  name: string;
  prefix: string;
  processId: string;
  workflowId?: string | undefined;
  description?: string | undefined;
}

export interface ProcessInstanceSummary {
  instanceId: string;
  name: string;
  subject?: string | undefined;
  state?: string | undefined;
  step?: string | undefined;
  status?: string | undefined;
  inStepSince?: string | undefined;
  dateDue?: string | undefined;
  [column: string]: unknown;
}

export interface ProcessAction {
  id: string;
  name: string;
}

export interface ProcessInstanceDetails {
  instanceId: string;
  name: string;
  title: string;
  project?: string | undefined;
  currentStep?: string | undefined;
  status?: string | undefined;
  subject?: string | undefined;
  /** Workflow actions the current user can take now (empty when not an actor). */
  actions: ProcessAction[];
  /** Whether the Save button is available (fields can be edited on this step). */
  canSave: boolean;
  /**
   * The step is assigned to a role and nobody has accepted it yet. Field edits only persist
   * after accepting ownership (acceptProcessOwnership / --accept-ownership).
   */
  ownershipPending: boolean;
  /** Unsubmitted draft (opens on the start form; submit with submitProcessDraft). */
  draft: boolean;
  fields: ProcessField[];
  url: string;
}

type Opts = SessionPageOptions;

/** Accepts confirm()/alert() dialogs (the caller asked for the action) and records them. */
function acceptDialogs(log: string[]) {
  return (page: puppeteer.Page) => {
    page.on('dialog', (d) => {
      log.push(`${d.type()}: ${d.message()}`);
      void d.accept().catch(() => {});
    });
  };
}

async function clickAndWait(page: puppeteer.Page, elementId: string): Promise<void> {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null),
    page.evaluate((id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Button #${id} not found`);
      el.click();
    }, elementId),
  ]);
  await waitForEBuilderPageToSettle(page);
}

// ---------------------------------------------------------------------------
// Projects & startable processes
// ---------------------------------------------------------------------------

async function fetchProjects(page: puppeteer.Page, origin: string): Promise<ProjectRef[]> {
  await gotoAuthenticated(page, `${origin}/da2/Processes/ProcessesMain.aspx`, origin);
  const result = await page.evaluate(async () => {
    const token = document.querySelector<HTMLInputElement>('[id$="h_securityToken"]')?.value;
    if (!token) return { error: 'Project list security token not found on ProcessesMain.aspx' };
    const res = await fetch('/da2/Controls/AjaxService.asmx/GetProjects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        context: {
          Text: '',
          NumberOfItems: 0,
          securityToken: token,
          virtualScrolling: 'false',
          ttActivityID: '',
        },
      }),
    });
    if (!res.ok) return { error: `GetProjects failed: HTTP ${res.status}` };
    const items = ((await res.json())?.d?.Items ?? []) as Array<{
      Text: string;
      Value: string;
      Attributes?: Record<string, string>;
    }>;
    return {
      projects: items.map((i) => ({
        id: i.Value.toLowerCase(),
        name: i.Attributes?.['Item1'] || i.Text,
        number: i.Attributes?.['Item2'] || undefined,
      })),
    };
  });
  if ('error' in result) throw new ProcessInstanceError(result.error!);
  return result.projects!;
}

function pickOne<T>(items: T[], key: string, nameOf: (t: T) => string, what: string): T {
  const k = key.trim().toLowerCase();
  const exact = items.filter((i) => nameOf(i).toLowerCase() === k);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length ? exact : items.filter((i) => nameOf(i).toLowerCase().includes(k));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) throw new ProcessInstanceError(`${what} "${key}" not found`);
  throw new ProcessInstanceError(
    `${what} "${key}" is ambiguous: ${partial.slice(0, 10).map(nameOf).join(', ')}${partial.length > 10 ? ', …' : ''}`,
  );
}

async function resolveProjectOnPage(
  page: puppeteer.Page,
  origin: string,
  project: string,
): Promise<ProjectRef> {
  const id = parseGuid(project);
  const projects = await fetchProjects(page, origin);
  if (id) {
    return projects.find((p) => p.id === id) ?? { id, name: project };
  }
  return pickOne(projects, project, (p) => p.name, 'Project');
}

export async function listProjects(options: Opts): Promise<ProjectRef[]> {
  return await withSessionPage(options, (page, origin) => fetchProjects(page, origin));
}

async function readStartable(page: puppeteer.Page, origin: string, projectId: string) {
  await gotoAuthenticated(
    page,
    `${origin}/da2/Processes/ProjectProcesses.aspx?PortalID={${projectId}}`,
    origin,
  );
  return await page.evaluate(() => {
    const fn = (window as any).getSelectProcessModalProcessOptions;
    const list = typeof fn === 'function' ? fn() : [];
    return (list as Array<Record<string, unknown>>).map((p) => ({
      name: String(p['name'] ?? ''),
      prefix: String(p['prefix'] ?? ''),
      processId: String(p['processId'] ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase(),
      workflowId:
        String(p['workflowId'] ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase() || undefined,
      description: (p['description'] as string | null) || undefined,
    }));
  });
}

export async function listStartableProcesses(
  options: Opts & { project: string },
): Promise<{ project: ProjectRef; processes: StartableProcess[] }> {
  return await withSessionPage(options, async (page, origin) => {
    const project = await resolveProjectOnPage(page, origin, options.project);
    return { project, processes: await readStartable(page, origin, project.id) };
  });
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** Lists the instances shown on the project's Processes page (its default view: open ones). */
export async function listProcessInstances(
  options: Opts & { project: string; process?: string | undefined; search?: string | undefined },
): Promise<{ project: ProjectRef; instances: ProcessInstanceSummary[] }> {
  return await withSessionPage(options, async (page, origin) => {
    const project = await resolveProjectOnPage(page, origin, options.project);
    await gotoAuthenticated(
      page,
      `${origin}/da2/Processes/ProjectProcesses.aspx?PortalID={${project.id}}`,
      origin,
    );
    let instances = await page.evaluate(() => {
      const table = document.querySelector<any>('modus-table');
      const rows: Array<Record<string, any>> = table?.data ?? [];
      const flat = (v: any) =>
        v && typeof v === 'object' ? (v.display ?? v.text ?? v.label ?? JSON.stringify(v)) : v;
      return rows.map((r) => {
        const out: Record<string, unknown> = {
          instanceId: String(r['instanceId'] ?? '')
            .replace(/[{}]/g, '')
            .toLowerCase(),
          name: r['instanceName'] ?? flat(r['process']),
        };
        for (const [k, v] of Object.entries(r)) {
          if (['instanceId', 'instanceName', 'process', 'isMailMergeDisabled'].includes(k))
            continue;
          const val = flat(v);
          if (val !== '' && val !== null && val !== undefined)
            out[k === 'open' ? 'state' : k] = val;
        }
        return out as { instanceId: string; name: string };
      });
    });
    if (options.process) {
      const p = options.process.toLowerCase();
      instances = instances.filter((i) => {
        const prefix = i.name.split(' - ')[0]?.toLowerCase();
        const type = String((i as Record<string, unknown>)['processType'] ?? '').toLowerCase();
        return prefix === p || type.includes(p);
      });
    }
    if (options.search) {
      const q = options.search.toLowerCase();
      instances = instances.filter((i) => JSON.stringify(i).toLowerCase().includes(q));
    }
    return { project, instances };
  });
}

async function readInstance(
  page: puppeteer.Page,
  instanceId: string,
): Promise<ProcessInstanceDetails> {
  const header = await page.evaluate((idPrefix: string) => {
    const t = (id: string) =>
      (document.getElementById(idPrefix + id)?.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      undefined;
    const subjectInput = document.querySelector<HTMLInputElement>('[name$="txtSubject"]');
    const actions = Array.from(
      document.querySelector<HTMLSelectElement>(`#${idPrefix}ddlActions`)?.options ?? [],
    )
      .filter((o) => o.value)
      .map((o) => ({ id: o.value.replace(/[{}]/g, '').toLowerCase(), name: o.text.trim() }));
    const save = document.getElementById(`${idPrefix}btnSave`) as HTMLElement | null;
    const accept = document.getElementById(`${idPrefix}btnAccept`) as HTMLElement | null;
    return {
      title: t('lblTitleHeader') ?? document.title,
      name: t('lblProcess'),
      project: t('lblProjectName'),
      currentStep: t('lblStep'),
      status: t('lblStatus'),
      subject: subjectInput?.value || t('lblSubject'),
      actions,
      canSave:
        Boolean(save && (save.offsetWidth || save.offsetHeight)) ||
        Boolean(document.getElementById(`${idPrefix}btnSaveDraft`)),
      ownershipPending: Boolean(accept && (accept.offsetWidth || accept.offsetHeight)),
      notFound: /e-Builder Error/i.test(document.title),
    };
  }, ID);
  if (header.notFound)
    throw new ProcessInstanceError(`Process instance ${instanceId} not found or not accessible`);
  const { notFound: _nf, ...rest } = header;
  const draft = /\/StartProcess\.aspx/i.test(page.url());
  return {
    instanceId,
    ...rest,
    name: rest.name ?? rest.title,
    draft,
    fields: await readFormFields(page),
    url: page.url(),
  };
}

function instanceUrl(origin: string, instanceId: string): string {
  return `${origin}/da2/Processes/InstanceDetails.aspx?InstanceID={${instanceId}}`;
}

function requireGuid(value: string, what: string): string {
  const id = parseGuid(value);
  if (!id) throw new ProcessInstanceError(`${what} must be a GUID (got "${value}")`);
  return id;
}

export async function getProcessInstance(
  options: Opts & { instanceId: string },
): Promise<ProcessInstanceDetails> {
  const instanceId = requireGuid(options.instanceId, 'Instance ID');
  return await withSessionPage(options, async (page, origin) => {
    await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
    return await readInstance(page, instanceId);
  });
}

function assertWrites(results: FieldWriteResult[]): void {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new ProcessInstanceError(
      `Could not set ${failed.length} field(s): ${failed.map((f) => `${f.field}: ${f.error}`).join('; ')}`,
      { fields: results },
    );
  }
}

const OWNERSHIP_HINT =
  'This step is assigned to a role and its ownership has not been accepted; e-Builder discards field edits until someone accepts it. Re-run with --accept-ownership (acceptOwnership: true) to take responsibility for the step.';

/** Clicks Accept (and its confirm dialog) when ownership is pending. Returns true if accepted. */
async function acceptOwnershipOnPage(
  page: puppeteer.Page,
  instanceId: string,
  origin: string,
): Promise<boolean> {
  const pending = await page.evaluate((idPrefix: string) => {
    const b = document.getElementById(`${idPrefix}btnAccept`) as HTMLElement | null;
    return Boolean(b && (b.offsetWidth || b.offsetHeight));
  }, ID);
  if (!pending) return false;
  await clickAndWait(page, `${ID}btnAccept`);
  await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
  const still = await page.evaluate((idPrefix: string) => {
    const b = document.getElementById(`${idPrefix}btnAccept`) as HTMLElement | null;
    return Boolean(b && (b.offsetWidth || b.offsetHeight));
  }, ID);
  if (still) throw new ProcessInstanceError('Accepting ownership did not take effect');
  return true;
}

/** Accepts ownership of the instance's current step (confirming e-Builder's prompt). */
export async function acceptProcessOwnership(
  options: Opts & { instanceId: string },
): Promise<{ accepted: boolean; instance: ProcessInstanceDetails; dialogs: string[] }> {
  const instanceId = requireGuid(options.instanceId, 'Instance ID');
  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      const accepted = await acceptOwnershipOnPage(page, instanceId, origin);
      return { accepted, instance: await readInstance(page, instanceId), dialogs };
    },
    { onPage: acceptDialogs(dialogs) },
  );
}

function sameValue(actual: unknown, wanted: FieldInputValue): boolean {
  const norm = (v: unknown) =>
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  if (typeof actual === 'boolean')
    return actual === /^(true|yes|y|1|on|checked)$/i.test(String(wanted));
  if (Array.isArray(actual)) {
    const want = (Array.isArray(wanted) ? wanted : String(wanted ?? '').split(/\s*[;|]\s*/))
      .map(norm)
      .filter(Boolean)
      .sort();
    return JSON.stringify(actual.map(norm).sort()) === JSON.stringify(want);
  }
  return norm(actual) === norm(wanted);
}

/**
 * Writes fields, tolerating controls that auto-post-back (e.g. radio lists): if the page
 * reloads mid-write it waits, re-reads, and re-applies whatever did not stick (up to 3 passes).
 */
async function applyFields(
  page: puppeteer.Page,
  values: Record<string, FieldInputValue>,
): Promise<FieldWriteResult[]> {
  let pending = { ...values };
  let results: FieldWriteResult[] = [];
  const byField = new Map<string, FieldWriteResult>();
  for (let pass = 0; pass < 3 && Object.keys(pending).length; pass++) {
    await page.evaluate(() => ((window as any).__ebMarker = true));
    const nav = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    results = await writeFormFields(page, pending);
    for (const r of results) byField.set(r.field, r);
    assertWrites(results);
    const reloaded =
      (await nav) ||
      !(await page.evaluate(() => Boolean((window as any).__ebMarker)).catch(() => false));
    if (reloaded) await waitForEBuilderPageToSettle(page);
    const current = await readFormFields(page);
    const next: Record<string, FieldInputValue> = {};
    for (const [key, wanted] of Object.entries(pending)) {
      const label = byField.get(key)?.label?.toLowerCase();
      const field = current.find(
        (f) => f.label.toLowerCase() === label || f.dataFieldId === parseGuid(key),
      );
      if (field && !sameValue(field.value, wanted)) next[key] = wanted;
    }
    pending = next;
  }
  if (Object.keys(pending).length) {
    throw new ProcessInstanceError(
      `These fields did not keep their new values: ${Object.keys(pending).join(', ')}`,
      { fields: [...byField.values()] },
    );
  }
  return [...byField.values()];
}

/** Sets fields on an instance and clicks Save. Nothing is saved if any field cannot be set. */
export async function setProcessInstanceFields(
  options: Opts & {
    instanceId: string;
    fields: Record<string, FieldInputValue>;
    dryRun?: boolean | undefined;
    acceptOwnership?: boolean | undefined;
  },
): Promise<{
  instance: ProcessInstanceDetails;
  fields: FieldWriteResult[];
  saved: boolean;
  acceptedOwnership: boolean;
  dialogs: string[];
}> {
  const instanceId = requireGuid(options.instanceId, 'Instance ID');
  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      let before = await readInstance(page, instanceId);
      let acceptedOwnership = false;
      if (before.ownershipPending) {
        if (!options.acceptOwnership)
          throw new ProcessInstanceError(OWNERSHIP_HINT, { step: before.currentStep });
        // Validate every field before taking responsibility for the step.
        assertWrites(await checkFormFields(page, options.fields));
        if (!options.dryRun) {
          acceptedOwnership = await acceptOwnershipOnPage(page, instanceId, origin);
          before = await readInstance(page, instanceId);
        }
      }
      if (!before.canSave) {
        throw new ProcessInstanceError(
          `Instance ${before.name} cannot be edited by this user at step "${before.currentStep}" (no Save button)`,
        );
      }
      const results = await applyFields(page, options.fields);
      if (options.dryRun)
        return { instance: before, fields: results, saved: false, acceptedOwnership, dialogs };

      await clickAndWait(page, `${ID}${before.draft ? 'btnSaveDraft' : 'btnSave'}`);
      const { banner, messages } = await readFormErrors(page);
      if (!banner || !/saved successfully/i.test(banner) || messages.length) {
        throw new ProcessInstanceError(
          `e-Builder did not save the instance: ${[banner, ...messages].filter(Boolean).join(' | ') || 'no confirmation'}`,
          { messages, dialogs },
        );
      }
      return {
        instance: await readInstance(page, instanceId),
        fields: results,
        saved: true,
        acceptedOwnership,
        dialogs,
      };
    },
    { onPage: acceptDialogs(dialogs) },
  );
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export interface StartProcessResult {
  project: ProjectRef;
  process: StartableProcess;
  submitted: boolean;
  draft: boolean;
  instance?: ProcessInstanceSummary | undefined;
  fields: FieldWriteResult[];
  dialogs: string[];
  message?: string | undefined;
}

/**
 * Starts a process in a project: fills subject + fields and clicks Submit (or Save Draft).
 * The new instance is located afterwards in the project's instance list by subject.
 */
export async function startProcessInstance(
  options: Opts & {
    project: string;
    process: string;
    subject?: string | undefined;
    fields?: Record<string, FieldInputValue> | undefined;
    draft?: boolean | undefined;
    dryRun?: boolean | undefined;
  },
): Promise<StartProcessResult> {
  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      const project = await resolveProjectOnPage(page, origin, options.project);
      const startable = await readStartable(page, origin, project.id);
      const pid = parseGuid(options.process);
      const process = pid
        ? startable.find((p) => p.processId === pid)
        : (() => {
            const byPrefix = startable.filter(
              (p) => p.prefix.toLowerCase() === options.process.toLowerCase(),
            );
            return byPrefix.length === 1
              ? byPrefix[0]
              : pickOne(startable, options.process, (p) => p.name, 'Process');
          })();
      if (!process) {
        throw new ProcessInstanceError(
          `Process "${options.process}" cannot be started in project "${project.name}"`,
        );
      }

      await gotoAuthenticated(
        page,
        `${origin}/da2/Processes/StartProcess.aspx?PortalID={${project.id}}&ProcessID={${process.processId}}`,
        origin,
      );

      const hasSubject = await page.evaluate(() =>
        Boolean(document.querySelector('[name$="txtSubject"]')),
      );
      if (options.subject !== undefined) {
        if (!hasSubject) {
          throw new ProcessInstanceError(
            `"${process.name}" generates its subject automatically; omit --subject`,
          );
        }
        await page.evaluate((s: string) => {
          const el = document.querySelector<HTMLInputElement>('[name$="txtSubject"]')!;
          el.value = s;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, options.subject);
      }

      const results = await applyFields(page, options.fields ?? {});
      if (options.dryRun) {
        return {
          project,
          process,
          submitted: false,
          draft: Boolean(options.draft),
          fields: results,
          dialogs,
        };
      }

      await clickAndWait(page, `${ID}${options.draft ? 'btnSaveDraft' : 'btnPostForm'}`);
      const { banner, messages } = await readFormErrors(page);
      const confirmed =
        Boolean(banner && /(submitted|saved) successfully/i.test(banner)) ||
        /[?&]formsubmit=1/i.test(page.url());
      if (messages.length || (!confirmed && banner)) {
        throw new ProcessInstanceError(
          `e-Builder rejected the form: ${[banner, ...messages].filter(Boolean).join(' | ')}`,
          { messages, dialogs },
        );
      }

      // Drafts keep the new instance id in the URL; submitted ones are found in the project list.
      let instance: ProcessInstanceSummary | undefined;
      const draftId = parseGuid(new URL(page.url()).searchParams.get('InstanceID') ?? '');
      if (draftId) instance = { instanceId: draftId, name: process.prefix };
      if (!instance && !options.draft) {
        await gotoAuthenticated(
          page,
          `${origin}/da2/Processes/ProjectProcesses.aspx?PortalID={${project.id}}`,
          origin,
        );
        instance = await page.evaluate(
          (prefix: string, subject: string | null) => {
            const rows: any[] = (document.querySelector<any>('modus-table')?.data ?? []).filter(
              (r: any) => String(r.instanceName ?? '').startsWith(`${prefix} - `),
            );
            const matching = subject
              ? rows.filter((r) => (r.subject?.display ?? r.subject) === subject)
              : rows;
            const counter = (r: any) => Number(String(r.instanceName).split(' - ').pop()) || 0;
            const best = matching.sort((a, b) => counter(b) - counter(a))[0];
            return best
              ? {
                  instanceId: String(best.instanceId).replace(/[{}]/g, '').toLowerCase(),
                  name: best.instanceName,
                  subject: best.subject?.display,
                  step: best.step,
                  status: best.status,
                }
              : undefined;
          },
          process.prefix,
          options.subject ?? null,
        );
      }
      if (!confirmed && !instance) {
        // Never report a failure that might have succeeded: callers would retry and duplicate.
        throw new ProcessInstanceError(
          `No confirmation from e-Builder and the new instance was not found. Check \`eb process instances --project "${project.name}"\` before retrying.`,
          { dialogs },
        );
      }
      return {
        project,
        process,
        submitted: !options.draft,
        draft: Boolean(options.draft),
        instance,
        fields: results,
        dialogs,
        message: banner ?? undefined,
      };
    },
    { onPage: acceptDialogs(dialogs) },
  );
}

export type ProcessInstanceOptions = Opts;

// ---------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------

export interface TakeActionResult {
  action: ProcessAction;
  before: { step?: string | undefined; status?: string | undefined };
  after: ProcessInstanceDetails;
  /** True when the instance left the step (or the action list changed). */
  advanced: boolean;
  commented: boolean;
  acceptedOwnership: boolean;
  fields: FieldWriteResult[];
  dialogs: string[];
}

/**
 * Takes a workflow action on an instance: optionally sets fields first, selects the action,
 * clicks Take Action, and completes the comment screen (txtNote / cbIsPrivate / btnSubmit)
 * when e-Builder shows one. The instance is re-read afterwards to confirm it moved.
 */
export async function takeProcessAction(
  options: Opts & {
    instanceId: string;
    action: string;
    comment?: string | undefined;
    privateComment?: boolean | undefined;
    fields?: Record<string, FieldInputValue> | undefined;
    acceptOwnership?: boolean | undefined;
  },
): Promise<TakeActionResult> {
  const instanceId = requireGuid(options.instanceId, 'Instance ID');
  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      const before = await readInstance(page, instanceId);
      if (before.draft) {
        throw new ProcessInstanceError(
          `${before.title} is an unsubmitted draft; submit it with \`eb process submit\``,
        );
      }
      if (!before.actions.length) {
        throw new ProcessInstanceError(
          `No actions are available to this user on ${before.name} (step "${before.currentStep}")`,
          { step: before.currentStep },
        );
      }
      const wantedId = parseGuid(options.action);
      const action = wantedId
        ? before.actions.find((a) => a.id === wantedId)
        : (() => {
            try {
              return pickOne(before.actions, options.action, (a) => a.name, 'Action');
            } catch {
              return undefined;
            }
          })();
      if (!action) {
        throw new ProcessInstanceError(
          `Action "${options.action}" is not available on ${before.name} (step "${before.currentStep}"). Available: ${before.actions.map((a) => a.name).join(', ')}`,
          { available: before.actions },
        );
      }

      let acceptedOwnership = false;
      if (before.ownershipPending && Object.keys(options.fields ?? {}).length) {
        if (!options.acceptOwnership)
          throw new ProcessInstanceError(OWNERSHIP_HINT, { step: before.currentStep });
        assertWrites(await checkFormFields(page, options.fields ?? {}));
        acceptedOwnership = await acceptOwnershipOnPage(page, instanceId, origin);
      }
      const results = await applyFields(page, options.fields ?? {});

      await page.select(`#${ID}ddlActions`, `{${action.id}}`).catch(async () => {
        await page.select(`#${ID}ddlActions`, action.id);
      });
      await clickAndWait(page, `${ID}btnTakeAction`);

      let commented = false;
      const commentScreen = await page.evaluate((idPrefix: string) => {
        const b = document.getElementById(`${idPrefix}btnSubmit`) as HTMLElement | null;
        return Boolean(b && (b.offsetWidth || b.offsetHeight));
      }, ID);
      if (commentScreen) {
        await page.evaluate(
          (idPrefix: string, note: string, priv: boolean) => {
            const ta = document.getElementById(`${idPrefix}txtNote`) as HTMLTextAreaElement | null;
            if (ta) {
              ta.value = note;
              ta.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const cb = document.getElementById(`${idPrefix}cbIsPrivate`) as HTMLInputElement | null;
            if (cb) cb.checked = priv;
          },
          ID,
          options.comment ?? '',
          Boolean(options.privateComment),
        );
        commented = Boolean(options.comment);
        await clickAndWait(page, `${ID}btnSubmit`);
        const stillThere = await page.evaluate((idPrefix: string) => {
          const b = document.getElementById(`${idPrefix}btnSubmit`) as HTMLElement | null;
          return Boolean(b && (b.offsetWidth || b.offsetHeight));
        }, ID);
        if (stillThere) {
          const { messages } = await readFormErrors(page);
          throw new ProcessInstanceError(
            `"${action.name}" was not completed${options.comment ? '' : ' (this action requires a comment: pass --comment)'}${messages.length ? `: ${messages.join(' | ')}` : ''}`,
            { messages, dialogs },
          );
        }
      } else {
        const { banner, messages } = await readFormErrors(page);
        if (messages.length || (banner && /error|invalid/i.test(banner))) {
          throw new ProcessInstanceError(
            `e-Builder rejected "${action.name}": ${[banner, ...messages].filter(Boolean).join(' | ')}`,
            { messages, dialogs },
          );
        }
      }

      // e-Builder moves to the next step asynchronously ("Moving to the next step…"):
      // while the step is unchanged and no actions are offered, re-read briefly.
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      let after = await readInstance(page, instanceId);
      for (
        let i = 0;
        i < 5 && after.currentStep === before.currentStep && !after.actions.length;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 3_000));
        await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
        after = await readInstance(page, instanceId);
      }
      const advanced =
        after.currentStep !== before.currentStep ||
        after.status !== before.status ||
        after.actions.map((a) => a.id).join() !== before.actions.map((a) => a.id).join();
      return {
        action,
        before: { step: before.currentStep, status: before.status },
        after,
        advanced,
        commented,
        acceptedOwnership,
        fields: results,
        dialogs,
      };
    },
    { onPage: acceptDialogs(dialogs) },
  );
}

/** Submits a draft instance (optionally setting fields first). */
export async function submitProcessDraft(
  options: Opts & { instanceId: string; fields?: Record<string, FieldInputValue> | undefined },
): Promise<{
  instance: ProcessInstanceDetails;
  fields: FieldWriteResult[];
  message?: string | undefined;
  dialogs: string[];
}> {
  const instanceId = requireGuid(options.instanceId, 'Instance ID');
  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      const before = await readInstance(page, instanceId);
      if (!before.draft)
        throw new ProcessInstanceError(
          `${before.name} is not a draft (step "${before.currentStep}")`,
        );
      const results = await applyFields(page, options.fields ?? {});
      await clickAndWait(page, `${ID}btnPostForm`);
      const { banner, messages } = await readFormErrors(page);
      if (messages.length || !banner || !/submitted successfully/i.test(banner)) {
        throw new ProcessInstanceError(
          `e-Builder did not submit the draft: ${[banner, ...messages].filter(Boolean).join(' | ') || 'no confirmation'}`,
          { messages, dialogs },
        );
      }
      await gotoAuthenticated(page, instanceUrl(origin, instanceId), origin);
      return {
        instance: await readInstance(page, instanceId),
        fields: results,
        message: banner,
        dialogs,
      };
    },
    { onPage: acceptDialogs(dialogs) },
  );
}
