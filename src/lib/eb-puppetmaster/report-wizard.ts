/**
 * Driver for e-Builder's custom report wizard (/da2/Reports/AddEditReport.aspx).
 *
 * The wizard is an ASP.NET WebForms page whose steps (DataType → Style → Columns → Aggregate →
 * ReorderColumns → Criteria, plus extra steps for Summary/Matrix styles) are swapped in with
 * async UpdatePanel postbacks. Unsaved wizard state lives in the server-side session, so
 * applying a config must set every control explicitly rather than relying on defaults.
 *
 * Saving goes through /da2/Reports/SaveReport.aspx (name, description, access, folder).
 */
import { waitForEBuilderPageToSettle } from './exec.js';

const P = 'ctl00$ctl00$ContentPlaceHolder1$contentSection$';
const ID = 'ctl00_ctl00_ContentPlaceHolder1_contentSection_';

export interface WizardOption {
  value: string;
  text: string;
}

export interface WizardColumn {
  /** CheckBoxList group, e.g. "ProjectInformation", "ProjectCustomFields", "BudgetInformation". */
  group: string;
  label: string;
}

export interface WizardOrderedColumn {
  /** Server field key, e.g. "Portals.Name" or "bli.AccountCode". */
  key: string;
  label: string;
}

export interface WizardSort extends WizardOrderedColumn {
  direction: 'ASC' | 'DESC';
}

/** Summary-report grouping level. */
export interface WizardGrouping extends WizardOrderedColumn {
  sortOrder: 'Asc' | 'Desc';
  /** Date bucket for date columns: Day, Week, Month, Quarter, Year, ... */
  dateGrouping?: string | undefined;
}

export interface WizardFilter {
  field: WizardOption;
  operator: WizardOption;
  value: string;
}

export interface WizardDateFilter {
  column: WizardOption;
  duration: WizardOption;
  start?: string | undefined;
  end?: string | undefined;
}

export type RawStepValues = Record<string, string | boolean | string[]>;

/** Step data as read from (or applied to) the wizard, keyed by ddlSteps value. */
export interface WizardStepData {
  DataType?: { reportType: WizardOption; reportSubType: WizardOption };
  Style?: { style: WizardOption };
  Columns?: {
    columns: WizardColumn[];
    expandMultiValuedFields: boolean;
    formulaColumns: string[];
  };
  Aggregate?: { aggregates: Array<{ column: string; functions: string[] }> };
  ReorderColumns?: { columnOrder: WizardOrderedColumn[]; sorts: WizardSort[] };
  Grouping?: { groupings: WizardGrouping[] };
  Criteria?: {
    dateFilter?: WizardDateFilter | undefined;
    requireProjectSelection: boolean;
    filters: WizardFilter[];
  };
  /** Steps without a dedicated model (e.g. Summary/Matrix grouping): raw control values. */
  raw?: Record<string, RawStepValues>;
}

const dialogLog = new WeakMap<puppeteer.Page, string[]>();

/** Dismisses (and records) alert/confirm dialogs so wizard validation never blocks automation. */
export function trackWizardDialogs(page: puppeteer.Page): void {
  if (dialogLog.has(page)) return;
  dialogLog.set(page, []);
  page.on('dialog', (d) => {
    dialogLog.get(page)!.push(d.message());
    void d.dismiss().catch(() => {});
  });
}

function takeDialogMessages(page: puppeteer.Page): string[] {
  const log = dialogLog.get(page) ?? [];
  return log.splice(0, log.length);
}

export class ReportWizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportWizardError';
  }
}

// ---------------------------------------------------------------------------
// Postback handling
// ---------------------------------------------------------------------------

async function installPostbackTracker(page: puppeteer.Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__ebPb) return;
    w.__ebPb = { end: 0, error: null as string | null };
    const prm = w.Sys?.WebForms?.PageRequestManager?.getInstance?.();
    prm?.add_endRequest((_sender: unknown, args: any) => {
      w.__ebPb.end++;
      const err = args?.get_error?.();
      if (err) {
        w.__ebPb.error = String(err.message || err);
        args.set_errorHandled?.(true);
      }
    });
  });
}

/**
 * Runs `trigger` and waits for the resulting postback to finish, whether it is an async
 * UpdatePanel request or a full page navigation.
 */
export async function postback(
  page: puppeteer.Page,
  trigger: () => Promise<unknown>,
  timeoutMs: number = 90_000,
): Promise<'ajax' | 'nav'> {
  await installPostbackTracker(page);
  const before = await page.evaluate(() => (window as any).__ebPb?.end ?? 0);

  const nav = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    .then(() => 'nav' as const)
    .catch(() => null);
  const ajax = page
    .waitForFunction(
      (n: number) => ((window as any).__ebPb?.end ?? 0) > n,
      { timeout: timeoutMs },
      before,
    )
    .then(() => 'ajax' as const)
    .catch(() => null);

  await trigger();

  const kind = await new Promise<'ajax' | 'nav' | null>((resolve) => {
    let pending = 2;
    for (const p of [nav, ajax]) {
      void p.then((v) => {
        if (v) resolve(v);
        else if (--pending === 0) resolve(null);
      });
    }
  });
  if (!kind) {
    throw new ReportWizardError(`Postback did not complete within ${timeoutMs / 1000}s`);
  }

  // After an async postback the PageRequestManager going idle is the real completion signal;
  // e-Builder pages keep background requests going, so waiting for network idle costs ~5s.
  await waitForEBuilderPageToSettle(page, 15_000, { networkIdle: kind === 'nav' });
  if (kind === 'ajax') {
    const error = await page.evaluate(() => {
      const pb = (window as any).__ebPb;
      const e = pb?.error;
      if (pb) pb.error = null;
      return e as string | null;
    });
    if (error) throw new ReportWizardError(`Server error during postback: ${error}`);
  }
  return kind;
}

/** Clicks an element by id (works for image buttons even when images are blocked). */
async function clickById(page: puppeteer.Page, id: string): Promise<void> {
  await page.evaluate((elId: string) => {
    const el = document.getElementById(elId) as HTMLElement | null;
    if (!el) throw new Error(`Element #${elId} not found`);
    el.click();
  }, id);
}

/** Returns the id of the first visible control whose id contains `fragment`. */
async function visibleControlId(page: puppeteer.Page, fragment: string): Promise<string | null> {
  return await page.evaluate((frag: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(`[id*="${frag}"]`)).find(
      (e) => e.offsetWidth > 0 || e.offsetHeight > 0,
    );
    return el?.id ?? null;
  }, fragment);
}

export async function currentStep(page: puppeteer.Page): Promise<string | null> {
  return await page.evaluate(
    () => document.querySelector<HTMLSelectElement>('select[name$="ddlSteps"]')?.value ?? null,
  );
}

export async function clickNext(page: puppeteer.Page): Promise<boolean> {
  const id = await visibleControlId(page, `${ID}btnNext`);
  if (!id) return false;
  await postback(page, () => clickById(page, id));
  return true;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Reads the visible wizard step. Runs entirely in the page. */
export async function readWizardStep(
  page: puppeteer.Page,
): Promise<{ step: string; data: WizardStepData }> {
  return await page.evaluate((P: string) => {
    const q = <T extends Element>(name: string) =>
      document.querySelector<T>(`[name="${P}${name}"]`);
    const visible = (e: Element) =>
      Boolean((e as HTMLElement).offsetWidth || (e as HTMLElement).offsetHeight);
    const opt = (sel: HTMLSelectElement | null) => {
      const o = sel?.selectedOptions[0];
      return { value: o?.value ?? '', text: (o?.text ?? '').trim() };
    };
    const labelOf = (el: HTMLInputElement) =>
      (el.labels?.[0]?.textContent ?? el.parentElement?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    const step = q<HTMLSelectElement>('ddlSteps')?.value ?? '';
    const data: Record<string, unknown> = {};

    if (step === 'DataType') {
      data['DataType'] = {
        reportType: opt(q('ddlReportType')),
        reportSubType: opt(q('lbReportSubType')),
      };
    } else if (step === 'Style') {
      const checked = document.querySelector<HTMLInputElement>(
        `input[name="${P}rblReportStyle"]:checked`,
      );
      const label = checked?.labels?.[0];
      const title = (
        label?.querySelector('b, strong')?.textContent ??
        label?.textContent?.match(/^(Tabular|Summary|Matrix)/)?.[1] ??
        ''
      ).trim();
      data['Style'] = { style: { value: checked?.value ?? '', text: title } };
    } else if (step === 'Columns') {
      const columns: Array<{ group: string; label: string }> = [];
      const formulaColumns: string[] = [];
      document.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
        const m = cb.name.match(/\$cbl([A-Za-z0-9_]+)\$\d+$/);
        if (m && cb.checked) columns.push({ group: m[1]!, label: labelOf(cb) });
        if (cb.id.includes('chkFormulaColumn') && cb.checked) formulaColumns.push(labelOf(cb));
      });
      data['Columns'] = {
        columns,
        expandMultiValuedFields: Boolean(q<HTMLInputElement>('chkExpandMPL')?.checked),
        formulaColumns,
      };
    } else if (step === 'Aggregate') {
      const aggregates: Array<{ column: string; functions: string[] }> = [];
      const grid = document.getElementById(
        'ctl00_ctl00_ContentPlaceHolder1_contentSection_dgAggregateColumns',
      ) as HTMLTableElement | null;
      for (const row of Array.from(grid?.rows ?? [])) {
        const boxes = Array.from(row.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
        if (boxes.length === 0) continue;
        const column = (row.cells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const functions = boxes
          .filter((b) => b.checked)
          .map((b) => (b.name.match(/\$chk([A-Za-z]+)$/)?.[1] ?? b.name).trim());
        aggregates.push({ column, functions });
      }
      data['Aggregate'] = { aggregates };
    } else if (step === 'ReorderColumns') {
      const list = q<HTMLSelectElement>('radLbReportColumns');
      const columnOrder = Array.from(list?.options ?? []).map((o) => ({
        key: o.value,
        label: o.text.trim(),
      }));
      const sorts: Array<{ key: string; label: string; direction: 'ASC' | 'DESC' }> = [];
      for (let i = 1; i <= 3; i++) {
        const sel = q<HTMLSelectElement>(`ddlSortCol${i}`);
        const o = sel?.selectedOptions[0];
        if (!o || !o.value) continue;
        const desc = document.querySelector<HTMLInputElement>(
          `input[name="${P}rblSortCol${i}"]:checked`,
        );
        sorts.push({
          key: o.value,
          label: o.text.trim(),
          direction: desc?.value === '1' ? 'DESC' : 'ASC',
        });
      }
      data['ReorderColumns'] = { columnOrder, sorts };
    } else if (step === 'Grouping') {
      const groupings: Array<{
        key: string;
        label: string;
        sortOrder: 'Asc' | 'Desc';
        dateGrouping?: string;
      }> = [];
      for (let i = 1; i <= 10; i++) {
        const col = q<HTMLSelectElement>(`ddlColumns${i}`);
        if (!col) break;
        const c = opt(col);
        if (!c.value) continue;
        const dates = q<HTMLSelectElement>(`ddlGroupDates${i}`);
        groupings.push({
          key: c.value,
          label: c.text,
          sortOrder: q<HTMLSelectElement>(`ddlSortOrder${i}`)?.value === 'Desc' ? 'Desc' : 'Asc',
          ...(dates && visible(dates) ? { dateGrouping: dates.value } : {}),
        });
      }
      data['Grouping'] = { groupings };
    } else if (step === 'Criteria') {
      const filters: Array<{
        field: { value: string; text: string };
        operator: { value: string; text: string };
        value: string;
      }> = [];
      for (let i = 1; i <= 10; i++) {
        const field = q<HTMLSelectElement>(`ddlField${i}`);
        if (!field) break;
        const f = opt(field);
        if (!f.value || f.value === 'Empty') continue;
        filters.push({
          field: f,
          operator: opt(q(`ddlCriteria${i}`)),
          value: q<HTMLInputElement>(`txtValue${i}`)?.value ?? '',
        });
      }
      const dateCol = q<HTMLSelectElement>('ddlStdDateColumns');
      const dateDur = q<HTMLSelectElement>('ddlStdDateDuration');
      const duration = opt(dateDur);
      // Start/end are only meaningful for a Custom (255) range; other ranges resolve them.
      const isCustom = duration.value === '255';
      const start = (isCustom && q<HTMLInputElement>('rdStdDateStart')?.value) || undefined;
      const end = (isCustom && q<HTMLInputElement>('rdStdDateEnd')?.value) || undefined;
      const hasDate = dateCol && (duration.value !== '255' || start || end);
      data['Criteria'] = {
        dateFilter: hasDate ? { column: opt(dateCol), duration, start, end } : undefined,
        requireProjectSelection: Boolean(q<HTMLInputElement>('chkProjectFilter')?.checked),
        filters,
      };
    } else if (step) {
      // Unmodelled step: capture visible simple controls by short name.
      const raw: Record<string, string | boolean | string[]> = {};
      const panel = Array.from(
        document.querySelectorAll('[id^="ctl00_ctl00_ContentPlaceHolder1_contentSection_pnlStep"]'),
      ).find((p) => /_pnlStep\d/.test(p.id) && visible(p));
      panel
        ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input, select, textarea',
        )
        .forEach((el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
          if (!el.name || !visible(el)) return;
          const name = el.name.replace(P, '');
          if (el instanceof HTMLInputElement) {
            if (['button', 'submit', 'image', 'hidden', 'file'].includes(el.type)) return;
            if (/btn/i.test(name)) return;
            if (el.type === 'checkbox') raw[name] = el.checked;
            else if (el.type === 'radio') {
              if (el.checked) raw[name] = el.value;
            } else raw[name] = el.value;
          } else if (el instanceof HTMLSelectElement) {
            raw[name] = el.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : el.value;
          } else {
            raw[name] = el.value;
          }
        });
      data['raw'] = { [step]: raw };
    }

    return { step, data: data as any };
  }, P);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Selects an option by value, falling back to (case-insensitive) text. If the select posts
 * back on change and the value actually changes, waits for the postback.
 * Returns false when no matching option exists.
 */
async function setSelect(
  page: puppeteer.Page,
  shortName: string,
  wanted: WizardOption | { value?: string; text?: string },
): Promise<boolean> {
  const result = await page.evaluate(
    (name: string, w: { value?: string; text?: string }) => {
      const sel = document.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
      if (!sel) return { found: false, changed: false, postsBack: false };
      const opts = Array.from(sel.options);
      const match =
        (w.value !== undefined && opts.find((o) => o.value === w.value)) ||
        (w.text !== undefined &&
          opts.find((o) => o.text.trim().toLowerCase() === w.text!.trim().toLowerCase()));
      if (!match) return { found: false, changed: false, postsBack: false };
      const changed = sel.value !== match.value;
      const postsBack = /__doPostBack/.test(sel.getAttribute('onchange') || '');
      if (changed && !postsBack) sel.value = match.value;
      return { found: true, changed, postsBack, value: match.value };
    },
    P + shortName,
    wanted,
  );
  if (!result.found) return false;
  if (result.changed && result.postsBack) {
    await postback(page, () =>
      page.evaluate(
        (name: string, value: string) => {
          const sel = document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
          sel.value = value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        },
        P + shortName,
        (result as { value: string }).value,
      ),
    );
  }
  return true;
}

async function setInputValue(page: puppeteer.Page, shortName: string, value: string) {
  await page.evaluate(
    (name: string, v: string) => {
      const el = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (el) el.value = v;
    },
    P + shortName,
    value,
  );
}

async function setChecked(page: puppeteer.Page, shortName: string, checked: boolean) {
  await page.evaluate(
    (name: string, c: boolean) => {
      const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (el) el.checked = c;
    },
    P + shortName,
    checked,
  );
}

/** Applies config data to the visible step. Returns warnings for things that could not be set. */
export async function applyWizardStep(
  page: puppeteer.Page,
  step: string,
  data: WizardStepData,
): Promise<string[]> {
  const warnings: string[] = [];

  if (step === 'DataType' && data.DataType) {
    if (!(await setSelect(page, 'ddlReportType', data.DataType.reportType))) {
      throw new ReportWizardError(
        `Report type "${data.DataType.reportType.text}" is not available`,
      );
    }
    if (!(await setSelect(page, 'lbReportSubType', data.DataType.reportSubType))) {
      throw new ReportWizardError(
        `Report sub-type "${data.DataType.reportSubType.text}" is not available`,
      );
    }
  } else if (step === 'Style' && data.Style) {
    const ok = await page.evaluate(
      (name: string, s: WizardOption) => {
        const radios = Array.from(
          document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`),
        );
        const r =
          radios.find((x) => x.value === s.value) ||
          radios.find((x) =>
            (x.labels?.[0]?.textContent ?? '')
              .trim()
              .toLowerCase()
              .startsWith(s.text.toLowerCase()),
          );
        if (r) r.checked = true;
        return Boolean(r);
      },
      P + 'rblReportStyle',
      data.Style.style,
    );
    if (!ok) warnings.push(`Style "${data.Style.style.text}" not found; left unchanged`);
  } else if (step === 'Columns' && data.Columns) {
    const missing = await page.evaluate((wanted: WizardColumn[]) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const want = new Set(wanted.map((c) => `${c.group}|${norm(c.label)}`));
      const found = new Set<string>();
      document.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
        const m = cb.name.match(/\$cbl([A-Za-z0-9_]+)\$\d+$/);
        if (!m) return;
        const label = norm(cb.labels?.[0]?.textContent ?? cb.parentElement?.textContent ?? '');
        const key = `${m[1]}|${label}`;
        cb.checked = want.has(key);
        if (cb.checked) found.add(key);
      });
      return wanted
        .filter((c) => !found.has(`${c.group}|${norm(c.label)}`))
        .map((c) => `${c.group}: ${c.label}`);
    }, data.Columns.columns);
    for (const m of missing) warnings.push(`Column not available in this account: ${m}`);
    await setChecked(page, 'chkExpandMPL', data.Columns.expandMultiValuedFields);
    if (data.Columns.formulaColumns.length > 0) {
      warnings.push(`Formula columns are not copied: ${data.Columns.formulaColumns.join(', ')}`);
    }
  } else if (step === 'Aggregate' && data.Aggregate) {
    const missing = await page.evaluate(
      (wanted: Array<{ column: string; functions: string[] }>) => {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const grid = document.getElementById(
          'ctl00_ctl00_ContentPlaceHolder1_contentSection_dgAggregateColumns',
        ) as HTMLTableElement | null;
        const byColumn = new Map(wanted.map((a) => [norm(a.column), new Set(a.functions)]));
        const seen = new Set<string>();
        for (const row of Array.from(grid?.rows ?? [])) {
          const col = norm(row.cells[0]?.textContent ?? '');
          const fns = byColumn.get(col);
          row.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((b) => {
            const fn = b.name.match(/\$chk([A-Za-z]+)$/)?.[1] ?? '';
            b.checked = Boolean(fns?.has(fn));
            if (fns) seen.add(col);
          });
        }
        return wanted
          .filter((a) => a.functions.length && !seen.has(norm(a.column)))
          .map((a) => a.column);
      },
      data.Aggregate.aggregates,
    );
    for (const m of missing) warnings.push(`Aggregate column not found: ${m}`);
  } else if (step === 'ReorderColumns' && data.ReorderColumns) {
    warnings.push(...(await applyColumnOrder(page, data.ReorderColumns.columnOrder)));
    for (let i = 1; i <= 3; i++) {
      const sort = data.ReorderColumns.sorts[i - 1];
      if (
        !(await setSelect(
          page,
          `ddlSortCol${i}`,
          sort ? { value: sort.key, text: sort.label } : { value: '' },
        ))
      ) {
        warnings.push(`Sort column not found: ${sort?.label}`);
        continue;
      }
      await page.evaluate(
        (name: string, desc: boolean) => {
          const r = document.querySelector<HTMLInputElement>(
            `input[name="${name}"][value="${desc ? '1' : '0'}"]`,
          );
          if (r) r.checked = true;
        },
        P + `rblSortCol${i}`,
        sort?.direction === 'DESC',
      );
    }
  } else if (step === 'Grouping' && data.Grouping) {
    const slots = await page.evaluate(
      (prefix: string) => document.querySelectorAll(`select[name^="${prefix}ddlColumns"]`).length,
      P,
    );
    for (let i = 1; i <= slots; i++) {
      const g = data.Grouping.groupings[i - 1];
      if (!g) {
        await setSelect(page, `ddlColumns${i}`, { value: '' });
        continue;
      }
      if (!(await setSelect(page, `ddlColumns${i}`, { value: g.key, text: g.label }))) {
        warnings.push(`Grouping column not available: ${g.label}`);
        continue;
      }
      await setSelect(page, `ddlSortOrder${i}`, { value: g.sortOrder });
      if (g.dateGrouping) await setSelect(page, `ddlGroupDates${i}`, { value: g.dateGrouping });
    }
    if (data.Grouping.groupings.length > slots) {
      warnings.push(`Only ${slots} grouping levels are supported`);
    }
  } else if (step === 'Criteria' && data.Criteria) {
    const c = data.Criteria;
    if (c.dateFilter) {
      if (!(await setSelect(page, 'ddlStdDateColumns', c.dateFilter.column))) {
        warnings.push(`Date filter column not found: ${c.dateFilter.column.text}`);
      }
      if (!(await setSelect(page, 'ddlStdDateDuration', c.dateFilter.duration))) {
        warnings.push(`Date filter range not found: ${c.dateFilter.duration.text}`);
      }
      if (c.dateFilter.start || c.dateFilter.end) {
        await page.evaluate(
          (startId: string, endId: string, s?: string, e?: string) => {
            const set = (id: string, v?: string) => {
              const picker = (window as any).$find?.(id);
              if (!v) return;
              const d = new Date(v);
              if (picker?.set_selectedDate && !isNaN(d.getTime())) picker.set_selectedDate(d);
            };
            set(startId, s);
            set(endId, e);
          },
          ID + 'rdStdDateStart',
          ID + 'rdStdDateEnd',
          c.dateFilter.start,
          c.dateFilter.end,
        );
      }
    } else {
      await setSelect(page, 'ddlStdDateDuration', { value: '255' });
    }
    await setChecked(page, 'chkProjectFilter', c.requireProjectSelection);

    const slots = await page.evaluate(
      (prefix: string) => document.querySelectorAll(`select[name^="${prefix}ddlField"]`).length,
      P,
    );
    if (c.filters.length > slots) {
      warnings.push(`Only ${slots} filters are supported; ${c.filters.length - slots} dropped`);
    }
    for (let i = 1; i <= slots; i++) {
      const f = c.filters[i - 1];
      if (!f) {
        await setSelect(page, `ddlField${i}`, { value: 'Empty' });
        await setInputValue(page, `txtValue${i}`, '');
        continue;
      }
      if (!(await setSelect(page, `ddlField${i}`, f.field))) {
        warnings.push(`Filter field not available: ${f.field.text}`);
        await setSelect(page, `ddlField${i}`, { value: 'Empty' });
        continue;
      }
      if (!(await setSelect(page, `ddlCriteria${i}`, f.operator))) {
        warnings.push(`Filter operator "${f.operator.text}" not available for ${f.field.text}`);
      }
      await setInputValue(page, `txtValue${i}`, f.value);
    }
  }

  const raw = data.raw?.[step];
  if (raw) {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'boolean') await setChecked(page, name, value);
      else if (Array.isArray(value)) {
        await page.evaluate(
          (n: string, vals: string[]) => {
            const sel = document.querySelector<HTMLSelectElement>(`select[name="${n}"]`);
            sel && Array.from(sel.options).forEach((o) => (o.selected = vals.includes(o.value)));
          },
          P + name,
          value,
        );
      } else {
        const isSelect = await page.evaluate(
          (n: string) => Boolean(document.querySelector(`select[name="${n}"]`)),
          P + name,
        );
        if (isSelect) await setSelect(page, name, { value });
        else {
          const isRadio = await page.evaluate(
            (n: string, v: string) => {
              const r = document.querySelector<HTMLInputElement>(
                `input[type=radio][name="${n}"][value="${v}"]`,
              );
              if (r) r.checked = true;
              return Boolean(r);
            },
            P + name,
            value,
          );
          if (!isRadio) await setInputValue(page, name, value);
        }
      }
    }
  }

  return warnings;
}

/**
 * Reorders the "Configure Columns" list. Each move is a server postback, so columns are moved
 * to the top from last to first, skipping the work when the order already matches.
 */
async function applyColumnOrder(
  page: puppeteer.Page,
  wanted: WizardOrderedColumn[],
): Promise<string[]> {
  const readOrder = () =>
    page.evaluate(
      (name: string) =>
        Array.from(
          document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)?.options ?? [],
        ).map((o) => ({ key: o.value, label: o.text.trim() })),
      P + 'radLbReportColumns',
    );
  const current = await readOrder();
  const warnings: string[] = [];
  const norm = (s: string) => s.trim().toLowerCase();
  const resolved = wanted
    .map((w) => {
      const hit =
        current.find((c) => c.key === w.key) ||
        current.find((c) => norm(c.label) === norm(w.label));
      if (!hit) warnings.push(`Ordered column not present: ${w.label}`);
      return hit?.key;
    })
    .filter((k): k is string => Boolean(k));

  const currentKeys = current.map((c) => c.key);
  const target = [...resolved, ...currentKeys.filter((k) => !resolved.includes(k))];
  if (target.every((k, i) => currentKeys[i] === k)) return warnings;

  for (const key of Array.from(resolved).reverse()) {
    await postback(page, async () => {
      await page.evaluate(
        (name: string, k: string) => {
          const sel = document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
          Array.from(sel.options).forEach((o) => (o.selected = o.value === k));
        },
        P + 'radLbReportColumns',
        key,
      );
      await clickById(page, ID + 'radBtnTop');
    });
  }

  const after = (await readOrder()).map((c) => c.key);
  if (!resolved.every((k, i) => after[i] === k)) {
    warnings.push('Column order could not be fully applied');
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Whole-wizard operations
// ---------------------------------------------------------------------------

/** Walks every step with Next (never saving) and returns the merged step data. */
export async function readWizard(
  page: puppeteer.Page,
): Promise<{ steps: string[]; data: WizardStepData }> {
  const merged: WizardStepData = {};
  const steps: string[] = [];
  for (let guard = 0; guard < 15; guard++) {
    const { step, data } = await readWizardStep(page);
    if (!step || steps.includes(step)) break;
    steps.push(step);
    const { raw, ...rest } = data;
    Object.assign(merged, rest);
    if (raw) merged.raw = { ...(merged.raw ?? {}), ...raw };
    if (!(await clickNext(page))) break;
  }
  return { steps, data: merged };
}

/** Applies data to every step, advancing with Next. Ends on the last step (not saved). */
export async function applyWizard(
  page: puppeteer.Page,
  data: WizardStepData,
): Promise<{ steps: string[]; warnings: string[] }> {
  const steps: string[] = [];
  const warnings: string[] = [];
  for (let guard = 0; guard < 15; guard++) {
    const step = await currentStep(page);
    if (!step || steps.includes(step)) break;
    steps.push(step);
    warnings.push(...(await applyWizardStep(page, step, data)));
    if (!(await clickNext(page))) break;
  }
  return { steps, warnings };
}

/**
 * Opens a fresh "new report" wizard the way the UI does (Reports → Add Report postback).
 * Navigating to AddEditReport.aspx directly reuses whatever wizard state the server session
 * holds — after a previous save that state is bound to that report and Save As fails.
 */
export async function startNewReportWizard(page: puppeteer.Page, origin: string): Promise<void> {
  await page.goto(`${origin}/da2/Reports/index.aspx`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await waitForEBuilderPageToSettle(page);
  const addId = await page.evaluate(
    () => document.querySelector<HTMLElement>('[id*="btnAddStandardReport"]')?.id ?? null,
  );
  if (!addId) throw new ReportWizardError('"Add Report" was not found on the Reports page');
  await postback(page, () => clickById(page, addId));
  if (!/\/AddEditReport\.aspx/i.test(page.url())) {
    throw new ReportWizardError(
      `"Add Report" did not open the report wizard (landed on ${page.url()})`,
    );
  }
}

export interface SaveReportOptions {
  name: string;
  description?: string | undefined;
  /** Folder name as shown in the report tree; defaults to "Unfiled Account Reports". */
  folder?: string | undefined;
  access?: 'Personal' | 'AllUsers' | undefined;
}

/** From any wizard step: Save As → fill SaveReport.aspx → Save. Returns warnings. */
export async function saveWizardAs(
  page: puppeteer.Page,
  options: SaveReportOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  const saveAsId = await visibleControlId(page, `${ID}btnSaveAs`);
  if (!saveAsId) throw new ReportWizardError('Save As button not found on the current wizard step');
  await postback(page, () => clickById(page, saveAsId));

  if (!/\/SaveReport\.aspx/i.test(page.url())) {
    throw new ReportWizardError(`Expected SaveReport.aspx after Save As, got ${page.url()}`);
  }

  await setInputValue(page, 'txtReportName', options.name);
  await setInputValue(page, 'txtReportDescription', options.description ?? '');
  const access = options.access ?? 'Personal';
  // Click (not just .checked) so the page's handlers enable the folder list for shared reports.
  const radio = await page.evaluate(
    (name: string, v: string) => {
      const r = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${v}"]`);
      if (!r) return null;
      const handler =
        (r.getAttribute('onclick') || '') + (r.parentElement?.getAttribute('onclick') || '');
      return { id: r.id, checked: r.checked, postsBack: /__doPostBack/.test(handler) };
    },
    P + 'rblRadAccessType',
    access,
  );
  if (!radio) throw new ReportWizardError(`Access option "${access}" not found on SaveReport.aspx`);
  if (!radio.checked) {
    if (radio.postsBack) await postback(page, () => clickById(page, radio.id));
    else await clickById(page, radio.id);
  }
  if (options.folder) {
    const folderDisabled = await page.evaluate(
      (name: string) =>
        Boolean(document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)?.disabled),
      P + 'ddlReportFolders',
    );
    if (access === 'Personal' || folderDisabled) {
      warnings.push(`Folder "${options.folder}" ignored: ${access} reports cannot be filed`);
    } else if (!(await setSelect(page, 'ddlReportFolders', { text: options.folder }))) {
      warnings.push(`Folder "${options.folder}" not found; saved to "Unfiled Account Reports"`);
    }
  }

  takeDialogMessages(page);
  await postback(page, () => clickById(page, ID + 'btnSave1'));
  if (/\/SaveReport\.aspx/i.test(page.url())) {
    const onPage = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '.errorMessage, .validation-summary-errors, [id*=lblError], [id*=lblMessage], [id*=Validator]',
        ),
      )
        .filter((e) => (e as HTMLElement).offsetWidth > 0 || (e as HTMLElement).offsetHeight > 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean),
    );
    const errorPage = await page.evaluate(() =>
      /e-Builder Error/i.test(document.body?.innerText ?? ''),
    );
    if (errorPage) onPage.unshift('e-Builder returned its error page');
    const details = [...takeDialogMessages(page), ...onPage].join(' | ');
    throw new ReportWizardError(`Report was not saved${details ? `: ${details}` : ''}`);
  }
  return warnings;
}
