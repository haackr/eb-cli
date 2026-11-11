/**
 * Project Details → Settings tab (/da2/Projects/ProjectDetailsEdit.aspx?PortalID={id}).
 *
 * Only the settings that are visible on a standard account are supported:
 * Project Access, Deny Techsupport Access, Enable Document Control, Workflow Due Date Offset,
 * Work Day Start/End Time and Work Week. Calendar exceptions, Plan Room, Client Project and the
 * Equipment notification rows are intentionally out of scope.
 *
 * Saving (verified on US2): the edit page posts the whole form via btnSave → SaveProject →
 * __doPostBack. Success redirects to ProjectDetails.aspx; a failed save stays on
 * ProjectDetailsEdit.aspx. The page tracks Settings edits in the hidden SettingsModified field,
 * which we always set when anything changes.
 */
import { waitForEBuilderPageToSettle } from './exec.js';
import { parseGuid, resolveProjectOnPage, type ProjectRef } from './process-instance.js';
import { gotoAuthenticated, withSessionPage, type SessionPageOptions } from './session-page.js';

const ID = 'ctl00_ctl00_ContentPlaceHolder1_contentSection_';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ProjectSettings {
  /** Project Access: visible to all users, or hidden from all users. */
  projectAccess: 'visible' | 'hidden';
  /** Deny Techsupport Access: true = e-Builder employees cannot access the project. */
  denyTechsupport: boolean;
  /** Enable Document Control. */
  documentControl: boolean;
  /** Workflow Due Date Offset (whole number). */
  workflowDueDateOffset: number;
  /** Work Day Start Time, as the page's option value (e.g. "7:00 am"). */
  workDayStart: string;
  /** Work Day End Time, as the page's option value (e.g. "3:00 pm"). */
  workDayEnd: string;
  /** Working days, Sunday first. */
  workWeek: Weekday[];
}

export type ProjectSettingKey = keyof ProjectSettings;
export type ProjectSettingsUpdate = Partial<ProjectSettings>;

export const PROJECT_SETTING_KEYS: ProjectSettingKey[] = [
  'projectAccess',
  'denyTechsupport',
  'documentControl',
  'workflowDueDateOffset',
  'workDayStart',
  'workDayEnd',
  'workWeek',
];

/** Human labels as shown on the Settings tab. */
export const PROJECT_SETTING_LABELS: Record<ProjectSettingKey, string> = {
  projectAccess: 'Project Access',
  denyTechsupport: 'Deny Techsupport Access',
  documentControl: 'Enable Document Control',
  workflowDueDateOffset: 'Workflow Due Date Offset',
  workDayStart: 'Work Day Start Time',
  workDayEnd: 'Work Day End Time',
  workWeek: 'Work Week',
};

export class ProjectSettingsError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProjectSettingsError';
  }
}

export interface ProjectSettingsSnapshot {
  /** Current values of the settings that are present and editable on the page. */
  settings: Partial<ProjectSettings>;
  /** Settings whose control is missing, hidden or read-only for this project/user. */
  unavailable: ProjectSettingKey[];
  /** Project name from the Details section of the edit page. */
  projectName?: string | undefined;
}

export interface ProjectSettingChange {
  setting: ProjectSettingKey;
  from: ProjectSettings[ProjectSettingKey] | undefined;
  to: ProjectSettings[ProjectSettingKey];
}

// ---------------------------------------------------------------------------
// Input parsing (shared by flags and CSV)
// ---------------------------------------------------------------------------

/** Raw string input keyed by setting; blank/undefined values mean "leave unchanged". */
export type ProjectSettingsInput = Partial<Record<ProjectSettingKey, string | undefined>>;

function parseYesNo(value: string, what: string): boolean {
  const v = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'on'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(v)) return false;
  throw new Error(`${what} must be yes or no (got "${value}")`);
}

function parseAccess(value: string): 'visible' | 'hidden' {
  const v = value.trim().toLowerCase();
  if (['visible', 'show', 'shown', 'visible to all users'].includes(v)) return 'visible';
  if (['hidden', 'hide', 'hidden from all users'].includes(v)) return 'hidden';
  throw new Error(`Project access must be visible or hidden (got "${value}")`);
}

function parseOffset(value: string): number {
  const v = value.trim();
  if (!/^-?\d{1,5}$/.test(v)) {
    throw new Error(`Workflow due date offset must be a whole number (got "${value}")`);
  }
  return Number(v);
}

/**
 * Normalizes a whole-hour time to the page's option format ("7:00 am").
 * Accepts "7", "7am", "7 AM", "7:00 am", "07:00 AM", "15", "15:00", "noon", "midnight".
 */
export function normalizeWorkTime(value: string): string {
  const v = value.trim().toLowerCase().replace(/\./g, '');
  if (v === 'noon') return '12:00 pm';
  if (v === 'midnight') return '12:00 am';
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) throw new Error(`Invalid time "${value}" (use e.g. "7:00 am" or "15:00")`);
  if (m[2] && m[2] !== '00') {
    throw new Error(`Work day times are whole hours only (got "${value}")`);
  }
  let hour = Number(m[1]);
  const suffix = m[3]?.[0];
  if (suffix) {
    if (hour < 1 || hour > 12) throw new Error(`Invalid time "${value}"`);
    if (suffix === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    throw new Error(`Invalid time "${value}"`);
  }
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${hour < 12 ? 'am' : 'pm'}`;
}

const DAY_ALIASES: Record<string, Weekday> = {
  sun: 'sun',
  sunday: 'sun',
  su: 'sun',
  mon: 'mon',
  monday: 'mon',
  mo: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  tu: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  we: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  th: 'thu',
  fri: 'fri',
  friday: 'fri',
  fr: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sa: 'sat',
};

function parseDay(token: string, original: string): Weekday {
  const d = DAY_ALIASES[token];
  if (!d) throw new Error(`Unknown day "${token}" in work week "${original}"`);
  return d;
}

/**
 * Parses a work week: "mon,tue,wed", "Monday Tuesday", "mon-fri", "weekdays", "all".
 * Returns unique days, Sunday first. Throws if no day is given.
 */
export function parseWorkWeek(value: string): Weekday[] {
  const days = new Set<Weekday>();
  const tokens = value
    .toLowerCase()
    .split(/[\s,;|/]+/)
    .filter(Boolean);
  for (const token of tokens) {
    if (token === 'weekdays') {
      ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((d) => days.add(d as Weekday));
      continue;
    }
    if (token === 'weekends' || token === 'weekend') {
      days.add('sat');
      days.add('sun');
      continue;
    }
    if (token === 'all' || token === 'everyday') {
      WEEKDAYS.forEach((d) => days.add(d));
      continue;
    }
    const range = token.match(/^([a-z]+)-([a-z]+)$/);
    if (range) {
      const a = WEEKDAYS.indexOf(parseDay(range[1]!, value));
      const b = WEEKDAYS.indexOf(parseDay(range[2]!, value));
      if (a > b) throw new Error(`Day range "${token}" must run Sunday→Saturday`);
      for (let i = a; i <= b; i++) days.add(WEEKDAYS[i]!);
      continue;
    }
    days.add(parseDay(token, value));
  }
  if (days.size === 0) throw new Error('Work week must include at least one day');
  return WEEKDAYS.filter((d) => days.has(d));
}

/**
 * Converts raw string inputs into a typed update. Blank values are skipped. Collects every
 * problem and throws a single error listing them all.
 */
export function parseProjectSettingsInput(input: ProjectSettingsInput): ProjectSettingsUpdate {
  const out: ProjectSettingsUpdate = {};
  const problems: string[] = [];
  const take = <K extends ProjectSettingKey>(key: K, fn: (v: string) => ProjectSettings[K]) => {
    const raw = input[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    try {
      out[key] = fn(String(raw));
    } catch (e: any) {
      problems.push(e.message);
    }
  };
  take('projectAccess', parseAccess);
  take('denyTechsupport', (v) => parseYesNo(v, 'Deny techsupport access'));
  take('documentControl', (v) => parseYesNo(v, 'Document control'));
  take('workflowDueDateOffset', parseOffset);
  take('workDayStart', normalizeWorkTime);
  take('workDayEnd', normalizeWorkTime);
  take('workWeek', parseWorkWeek);
  if (problems.length) throw new ProjectSettingsError(problems.join('; '), { problems });
  return out;
}

// ---------------------------------------------------------------------------
// Diff & validation
// ---------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

export function diffProjectSettings(
  current: Partial<ProjectSettings>,
  update: ProjectSettingsUpdate,
): ProjectSettingChange[] {
  const changes: ProjectSettingChange[] = [];
  for (const key of PROJECT_SETTING_KEYS) {
    const to = update[key];
    if (to === undefined) continue;
    if (!sameValue(current[key], to)) changes.push({ setting: key, from: current[key], to });
  }
  return changes;
}

/** Mirrors the page's own client-side checks on the merged (resulting) settings. */
export function validateProjectSettings(merged: Partial<ProjectSettings>): string[] {
  const errors: string[] = [];
  if (merged.workWeek && merged.workWeek.length === 0) {
    errors.push('Work week must include at least one working day.');
  }
  if (merged.workDayStart && merged.workDayEnd && merged.workDayStart === merged.workDayEnd) {
    errors.push('Work day start and end time must be different.');
  }
  return errors;
}

export function formatSettingValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

// ---------------------------------------------------------------------------
// Page operations (exported for tests)
// ---------------------------------------------------------------------------

/** Reads the Settings tab of a loaded ProjectDetailsEdit page. */
export async function readProjectSettingsFromPage(
  page: puppeteer.Page | puppeteer.Frame,
): Promise<ProjectSettingsSnapshot> {
  return await page.evaluate(
    (P: string, days: readonly string[]) => {
      const el = <T extends HTMLElement>(id: string) => document.getElementById(P + id) as T | null;
      // Hidden by its own row/table (not merely because the Settings tab is inactive).
      const usable = (e: HTMLElement | null): boolean => {
        if (!e || (e as HTMLInputElement).disabled) return false;
        const pv = el('pvSettings');
        for (let n: HTMLElement | null = e; n && n !== pv; n = n.parentElement) {
          if (n.style?.display === 'none') return false;
        }
        return true;
      };
      const radio = (name: string): string | undefined => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(`input[type=radio][id^="${P}${name}_"]`),
        );
        if (!inputs.length || !inputs.every(usable)) return undefined;
        return inputs.find((i) => i.checked)?.value;
      };
      const settings: Record<string, unknown> = {};
      const unavailable: string[] = [];
      const put = (key: string, value: unknown) => {
        if (value === undefined) unavailable.push(key);
        else settings[key] = value;
      };

      const access = radio('rblAllowUserLogins');
      put(
        'projectAccess',
        access === undefined ? undefined : access === '1' ? 'visible' : 'hidden',
      );
      const deny = radio('rblDenyTechsupport');
      put('denyTechsupport', deny === undefined ? undefined : deny === '1');
      const doc = radio('rblEnableDocumentControl');
      put('documentControl', doc === undefined ? undefined : doc === '1');

      const offset = el<HTMLInputElement>('tbWorkflowDueDateOffset');
      put(
        'workflowDueDateOffset',
        usable(offset) && /^-?\d+$/.test(offset!.value.trim())
          ? Number(offset!.value.trim())
          : undefined,
      );

      for (const [key, id] of [
        ['workDayStart', 'StartTime'],
        ['workDayEnd', 'EndTime'],
      ] as const) {
        const sel = el<HTMLSelectElement>(id);
        put(key, usable(sel) ? sel!.value : undefined);
      }

      const boxes = days.map((_, i) => el<HTMLInputElement>(`chkWorkWeek_${i}`));
      put(
        'workWeek',
        boxes.every((b) => usable(b)) ? days.filter((_, i) => boxes[i]!.checked) : undefined,
      );

      const name = el<HTMLInputElement>('tbProjectName')?.value?.trim() || undefined;
      return { settings, unavailable, projectName: name } as any;
    },
    ID,
    WEEKDAYS,
  );
}

/** Writes the update into the Settings tab controls (no save) and marks the settings modified. */
export async function applyProjectSettingsOnPage(
  page: puppeteer.Page | puppeteer.Frame,
  update: ProjectSettingsUpdate,
): Promise<void> {
  const problem = await page.evaluate(
    (P: string, u: ProjectSettingsUpdate) => {
      const el = <T extends HTMLElement>(id: string) => document.getElementById(P + id) as T | null;
      const setRadio = (name: string, value: string): string | null => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(`input[type=radio][id^="${P}${name}_"]`),
        );
        const target = inputs.find((i) => i.value === value);
        if (!target) return `${name}: option ${value} not found`;
        // click() checks it, unchecks the rest of the group and runs the page's onclick handlers.
        if (!target.checked) target.click();
        return null;
      };
      const setSelect = (id: string, value: string): string | null => {
        const sel = el<HTMLSelectElement>(id);
        if (!sel) return `${id} not found`;
        if (!Array.from(sel.options).some((o) => o.value === value)) {
          return `"${value}" is not an option for ${id}`;
        }
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      };

      const errs: (string | null)[] = [];
      if (u.projectAccess !== undefined) {
        errs.push(setRadio('rblAllowUserLogins', u.projectAccess === 'visible' ? '1' : '0'));
      }
      if (u.denyTechsupport !== undefined) {
        errs.push(setRadio('rblDenyTechsupport', u.denyTechsupport ? '1' : '0'));
      }
      if (u.documentControl !== undefined) {
        errs.push(setRadio('rblEnableDocumentControl', u.documentControl ? '1' : '0'));
      }
      if (u.workflowDueDateOffset !== undefined) {
        const tb = el<HTMLInputElement>('tbWorkflowDueDateOffset');
        if (!tb) errs.push('tbWorkflowDueDateOffset not found');
        else {
          tb.value = String(u.workflowDueDateOffset);
          tb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (u.workDayStart !== undefined) errs.push(setSelect('StartTime', u.workDayStart));
      if (u.workDayEnd !== undefined) errs.push(setSelect('EndTime', u.workDayEnd));
      if (u.workWeek !== undefined) {
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        days.forEach((d, i) => {
          const cb = el<HTMLInputElement>(`chkWorkWeek_${i}`);
          if (!cb) errs.push(`chkWorkWeek_${i} not found`);
          else {
            cb.checked = u.workWeek!.includes(d as any);
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }

      // Some controls notify the server through onChangeSetting(); others don't. Always flag it.
      const modified = el<HTMLInputElement>('SettingsModified');
      if (modified) modified.value = 'true';

      return errs.filter(Boolean).join('; ') || null;
    },
    ID,
    update,
  );
  if (problem) throw new ProjectSettingsError(`Could not set settings: ${problem}`);
}

/** Visible validator / error messages on the edit page after a failed save. */
export async function readProjectSaveErrors(
  page: puppeteer.Page | puppeteer.Frame,
): Promise<string[]> {
  return await page.evaluate(() => {
    const visible = (e: Element) => {
      const s = getComputedStyle(e);
      return s.display !== 'none' && s.visibility !== 'hidden' && (e as HTMLElement).offsetParent;
    };
    const texts = Array.from(
      document.querySelectorAll(
        'span[id*="val"], .validator, [id*="ValidationSummary"], [id*="lblError"], [id*="lblMessage"], .ErrorMessage, .error-message',
      ),
    )
      .filter(visible)
      .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 1);
    return Array.from(new Set(texts));
  });
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface ProjectSettingsOptions extends SessionPageOptions {
  /** Exact project name (case-insensitive) or PortalID GUID. Hidden projects need the PortalID. */
  project: string;
}

export interface ProjectSettingsResult {
  project: ProjectRef;
  settings: Partial<ProjectSettings>;
  unavailable: ProjectSettingKey[];
  url: string;
}

export interface SetProjectSettingsResult extends ProjectSettingsResult {
  changes: ProjectSettingChange[];
  /** True when the form was saved (false for dry runs and when nothing changed). */
  saved: boolean;
  dryRun: boolean;
}

function editUrl(origin: string, projectId: string): string {
  return `${origin}/da2/Projects/ProjectDetailsEdit.aspx?PortalID=${projectId}`;
}

async function openSettings(
  page: puppeteer.Page,
  origin: string,
  project: string,
): Promise<{ project: ProjectRef; snapshot: ProjectSettingsSnapshot; url: string }> {
  const id = parseGuid(project);
  const ref: ProjectRef = id
    ? { id, name: project }
    : await resolveProjectOnPage(page, origin, project, { exact: true });
  const url = editUrl(origin, ref.id);
  await gotoAuthenticated(page, url, origin);
  if (!(await page.$(`#${ID}pvSettings`))) {
    throw new ProjectSettingsError(
      `Project settings are not available for "${ref.name}" (no Settings tab on ${page.url()}). Check the project exists and that you can edit project details.`,
      { url: page.url() },
    );
  }
  const snapshot = await readProjectSettingsFromPage(page);
  if (snapshot.projectName) ref.name = snapshot.projectName;
  return { project: ref, snapshot, url };
}

export async function getProjectSettings(
  options: ProjectSettingsOptions,
): Promise<ProjectSettingsResult> {
  return await withSessionPage(options, async (page, origin) => {
    const { project, snapshot, url } = await openSettings(page, origin, options.project);
    return { project, settings: snapshot.settings, unavailable: snapshot.unavailable, url };
  });
}

export async function setProjectSettings(
  options: ProjectSettingsOptions & { settings: ProjectSettingsUpdate; dryRun?: boolean },
): Promise<SetProjectSettingsResult> {
  const dryRun = Boolean(options.dryRun);
  const requested = PROJECT_SETTING_KEYS.filter((k) => options.settings[k] !== undefined);
  if (!requested.length) throw new ProjectSettingsError('No settings to change');

  const dialogs: string[] = [];
  return await withSessionPage(
    options,
    async (page, origin) => {
      const { project, snapshot, url } = await openSettings(page, origin, options.project);

      const blocked = requested.filter((k) => snapshot.unavailable.includes(k));
      if (blocked.length) {
        throw new ProjectSettingsError(
          `Not editable on "${project.name}": ${blocked.map((k) => PROJECT_SETTING_LABELS[k]).join(', ')}`,
          { unavailable: blocked },
        );
      }

      const changes = diffProjectSettings(snapshot.settings, options.settings);
      const base = { project, unavailable: snapshot.unavailable, url, changes, dryRun };
      if (!changes.length) {
        return { ...base, settings: snapshot.settings, saved: false };
      }

      const merged = { ...snapshot.settings, ...options.settings };
      const invalid = validateProjectSettings(merged);
      if (invalid.length) throw new ProjectSettingsError(invalid.join(' '), { invalid });

      if (dryRun) return { ...base, settings: merged, saved: false };

      await applyProjectSettingsOnPage(page, options.settings);
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 })
          .catch(() => null),
        page.evaluate((id: string) => {
          const btn = document.getElementById(id);
          if (!btn) throw new Error('Save button not found');
          btn.click();
        }, `${ID}btnSave`),
      ]);
      await waitForEBuilderPageToSettle(page);

      if (/ProjectDetailsEdit\.aspx/i.test(page.url())) {
        const errors = [...dialogs, ...(await readProjectSaveErrors(page))];
        throw new ProjectSettingsError(
          `e-Builder did not save the project${errors.length ? `: ${errors.join(' | ')}` : ' (still on the edit page)'}`,
          { errors },
        );
      }

      // Verify by reading the settings back.
      await gotoAuthenticated(page, url, origin);
      const after = await readProjectSettingsFromPage(page);
      const notSaved = diffProjectSettings(after.settings, options.settings);
      if (notSaved.length) {
        throw new ProjectSettingsError(
          `Saved, but these settings did not change: ${notSaved
            .map(
              (c) =>
                `${PROJECT_SETTING_LABELS[c.setting]} is "${formatSettingValue(c.from)}", expected "${formatSettingValue(c.to)}"`,
            )
            .join('; ')}`,
          { notSaved },
        );
      }
      return { ...base, settings: after.settings, saved: true };
    },
    {
      onPage: (page) =>
        page.on('dialog', (d) => {
          dialogs.push(`${d.type()}: ${d.message()}`);
          void d.dismiss().catch(() => {});
        }),
    },
  );
}
