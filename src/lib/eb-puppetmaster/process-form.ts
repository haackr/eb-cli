/**
 * In-page reader/writer for e-Builder process data fields (StartProcess.aspx and
 * InstanceDetails.aspx). Each field is a `td.Label` row under the data-fields section whose
 * controls are named by the DataFieldID GUID; read-only values render as a span with that id.
 *
 * `installFormHelper` defines `window.__ebForm` in the page; everything else calls into it.
 */

export type ProcessFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'checklist'
  | 'date'
  | 'combo'
  | 'file'
  | 'readonly';

export interface ProcessField {
  label: string;
  dataFieldId?: string | undefined;
  type: ProcessFieldType;
  value: string | boolean | string[] | null;
  editable: boolean;
  required: boolean;
  options?: string[] | undefined;
}

export type FieldInputValue = string | number | boolean | string[] | null;

export interface FieldWriteResult {
  field: string;
  ok: boolean;
  label?: string | undefined;
  type?: ProcessFieldType | undefined;
  error?: string | undefined;
}

/** Installs window.__ebForm. Self-contained (serialized into the page). */
function formHelper(): void {
  const w = window as any;
  if (w.__ebForm) return;

  const clean = (s: string | null | undefined) =>
    (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const cleanLabel = (s: string) =>
    clean(s)
      .replace(/^\*\s*/, '')
      .replace(/[\s:*]+$/, '');
  const GUID = /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i;
  const visible = (e: Element) =>
    Boolean((e as HTMLElement).offsetWidth || (e as HTMLElement).offsetHeight);
  const fire = (el: Element) => {
    for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
  };
  const labelText = (el: HTMLInputElement) =>
    clean(el.labels?.[0]?.textContent ?? el.parentElement?.textContent ?? el.value);

  type Row = { label: string; required: boolean; cell: Element; dataFieldId?: string };

  const rows = (): Row[] => {
    // Embedded sub-controls (commitment / line-item pickers and their search bars) render
    // their own td.Label cells inside the data-fields section; they are not data fields.
    const SUB_CONTROL =
      '[id*="LineItemsControl"], [id*="CommitmentControl"], [id*="ucEquipmentItems"], [id*="RadAjaxPanel"], [id*="ucItemCF"]';
    const labels = Array.from(
      document.querySelectorAll(
        '[id$="_dataFields"] td.Label, #ctl00_contentSection_dataFields td.Label',
      ),
    ).filter((lab) => {
      // Only sub-controls *inside* the data-fields container count; a wrapper around the
      // whole section (e.g. a page-level RadAjaxPanel) must not hide every field.
      const container = lab.closest('[id$="_dataFields"]');
      const sub = lab.closest(SUB_CONTROL);
      return !(sub && container && sub !== container && container.contains(sub));
    });
    return Array.from(new Set(labels))
      .map((lab) => {
        const cell = (lab.nextElementSibling as Element | null) ?? lab.parentElement!;
        const named = cell.querySelector('[name*="{"], [id^="{"]');
        const id = (named?.getAttribute('name') || named?.id || '').match(GUID)?.[1]?.toLowerCase();
        return {
          label: cleanLabel(lab.textContent ?? ''),
          required: /^\s*\*/.test(lab.textContent ?? ''),
          cell,
          ...(id ? { dataFieldId: id } : {}),
        };
      })
      .filter((r) => r.label);
  };

  const radCombo = (cell: Element) => {
    const el = cell.querySelector('.RadComboBox');
    return el ? w.$find?.(el.id) : null;
  };
  const datePicker = (cell: Element) => {
    const input = cell.querySelector<HTMLInputElement>('input[id$="_dateInput"]');
    if (!input) return null;
    return w.$find?.(input.id.replace(/_dateInput$/, '')) ?? null;
  };

  const inspect = (r: Row) => {
    const cell = r.cell;
    const controls = Array.from(
      cell.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea',
      ),
    ).filter((e) => e.type !== 'hidden' && e.type !== 'button' && e.type !== 'submit');
    const enabled = controls.filter((e) => !e.disabled && !(e as HTMLInputElement).readOnly);
    const base = { label: r.label, dataFieldId: r.dataFieldId, required: r.required };

    if (
      cell.querySelector('input[type=button][value^="Browse"]') ||
      Array.from(cell.querySelectorAll('input')).some((i) => /\}name$/.test(i.name))
    ) {
      return { ...base, type: 'file', value: clean(cell.textContent) || null, editable: false };
    }
    const dp = datePicker(cell);
    if (dp || cell.querySelector('input[id$="_dateInput"]')) {
      const input = cell.querySelector<HTMLInputElement>('input[id$="_dateInput"]')!;
      return { ...base, type: 'date', value: input.value || null, editable: !input.disabled };
    }
    const combo = radCombo(cell);
    if (combo || cell.querySelector('.RadComboBox')) {
      const input = cell.querySelector<HTMLInputElement>('.RadComboBox input.rcbInput');
      const options: string[] = [];
      const items = combo?.get_items?.();
      for (let i = 0; i < (items?.get_count?.() ?? 0); i++)
        options.push(clean(items.getItem(i).get_text()));
      return {
        ...base,
        type: 'combo',
        value: clean(combo?.get_text?.() ?? input?.value) || null,
        editable: Boolean(input && !input.disabled),
        ...(options.length ? { options } : {}),
      };
    }
    const radios = controls.filter((e): e is HTMLInputElement => e.type === 'radio');
    if (radios.length) {
      const checked = radios.find((x) => x.checked);
      return {
        ...base,
        type: 'radio',
        value: checked ? labelText(checked) : null,
        editable: radios.some((x) => !x.disabled),
        options: radios.map(labelText),
      };
    }
    const boxes = controls.filter((e): e is HTMLInputElement => e.type === 'checkbox');
    if (boxes.length > 1) {
      return {
        ...base,
        type: 'checklist',
        value: boxes.filter((b) => b.checked).map(labelText),
        editable: boxes.some((b) => !b.disabled),
        options: boxes.map(labelText),
      };
    }
    if (boxes.length === 1) {
      return { ...base, type: 'checkbox', value: boxes[0]!.checked, editable: !boxes[0]!.disabled };
    }
    const sel = controls.find((e): e is HTMLSelectElement => e instanceof HTMLSelectElement);
    if (sel) {
      const picked = Array.from(sel.selectedOptions)
        .map((o) => clean(o.text))
        .filter(Boolean);
      return {
        ...base,
        type: sel.multiple ? 'multiselect' : 'select',
        value: sel.multiple ? picked : (picked[0] ?? null),
        editable: !sel.disabled,
        options: Array.from(sel.options)
          .map((o) => clean(o.text))
          .filter(Boolean),
      };
    }
    const ta = controls.find((e) => e instanceof HTMLTextAreaElement);
    if (ta)
      return { ...base, type: 'textarea', value: ta.value || null, editable: enabled.includes(ta) };
    const text = controls.find((e) => e instanceof HTMLInputElement);
    if (text)
      return { ...base, type: 'text', value: text.value || null, editable: enabled.includes(text) };
    // Read-only rendering: the value span's id ends with "{DataFieldID}" (often prefixed with
    // ctl00_contentSection_ or ctl00_contentSection_lbl) or its name is "{DataFieldID}".
    // Without one, read the cell minus help-text <div>s and [Lookup]/[Remove] action links.
    const span = r.dataFieldId
      ? cell.querySelector<HTMLElement>(
          `span[id$="{${r.dataFieldId}}"], span[name="{${r.dataFieldId}}"]`,
        )
      : null;
    let rawText = '';
    if (span) {
      rawText = span.textContent ?? '';
    } else {
      const clone = cell.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll('div, a[href^="javascript:"], a[onclick], script, style')
        .forEach((el) => el.remove());
      rawText = clone.textContent ?? '';
    }
    return {
      ...base,
      type: 'readonly',
      value: clean(rawText) || null,
      editable: false,
    };
  };

  const find = (key: string): { row?: Row; error?: string } => {
    const all = rows();
    const id = key.match(GUID)?.[1]?.toLowerCase();
    if (id) {
      const row = all.find((r) => r.dataFieldId === id);
      return row ? { row } : { error: `No field with DataFieldID ${id}` };
    }
    const k = cleanLabel(key).toLowerCase();
    const exact = all.filter((r) => r.label.toLowerCase() === k);
    if (exact.length === 1) return { row: exact[0]! };
    if (exact.length > 1)
      return { error: `Field label "${key}" is ambiguous; use its DataFieldID` };
    const partial = all.filter((r) => r.label.toLowerCase().includes(k));
    if (partial.length === 1) return { row: partial[0]! };
    return {
      error: partial.length
        ? `Field "${key}" is ambiguous: ${partial.map((r) => r.label).join(', ')}`
        : `Field "${key}" not found`,
    };
  };

  const truthy = (v: unknown) => /^(true|yes|y|1|on|checked)$/i.test(String(v).trim());
  const asList = (v: unknown) =>
    (Array.isArray(v) ? v : String(v ?? '').split(/\s*[;|]\s*/))
      .map((x) => clean(String(x)))
      .filter(Boolean);
  const pickByText = <T extends { text: string; value: string }>(opts: T[], v: string) =>
    opts.find((o) => clean(o.text).toLowerCase() === v.toLowerCase()) ??
    opts.find((o) => o.value === v);

  const write = (key: string, value: unknown) => {
    const { row, error } = find(key);
    if (!row) return { field: key, ok: false, error };
    const info: any = inspect(row);
    const out = { field: key, label: row.label, type: info.type };
    if (!info.editable) {
      return {
        ...out,
        ok: false,
        error: `Field "${row.label}" is not editable on this step (${info.type})`,
      };
    }
    const cell = row.cell;
    const str = value === null || value === undefined ? '' : String(value);
    switch (info.type) {
      case 'text':
      case 'textarea': {
        const el = Array.from(
          cell.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input'),
        ).find((e) => (e.type === 'text' || e instanceof HTMLTextAreaElement) && !e.disabled)!;
        el.value = str;
        fire(el);
        return { ...out, ok: true };
      }
      case 'select':
      case 'multiselect': {
        const sel = cell.querySelector('select')!;
        const opts = Array.from(sel.options).map((o) => ({ o, text: o.text, value: o.value }));
        if (info.type === 'multiselect') {
          const wanted = asList(value).map((x) => x.toLowerCase());
          const missing = wanted.filter(
            (x) =>
              !opts.some((o) => clean(o.text).toLowerCase() === x || o.value.toLowerCase() === x),
          );
          if (missing.length)
            return { ...out, ok: false, error: `Options not found: ${missing.join(', ')}` };
          opts.forEach(
            (o) =>
              (o.o.selected =
                wanted.includes(clean(o.text).toLowerCase()) ||
                wanted.includes(o.value.toLowerCase())),
          );
        } else {
          const hit =
            str === '' ? opts.find((o) => !o.value || !clean(o.text)) : pickByText(opts, str);
          if (!hit)
            return {
              ...out,
              ok: false,
              error: `Option "${str}" not found (options: ${info.options?.join(', ')})`,
            };
          sel.value = hit.value;
        }
        fire(sel);
        return { ...out, ok: true };
      }
      case 'radio': {
        const radios = Array.from(cell.querySelectorAll<HTMLInputElement>('input[type=radio]'));
        if (str === '') {
          radios.forEach((r) => (r.checked = false));
          return { ...out, ok: true };
        }
        const r = radios.find(
          (x) => labelText(x).toLowerCase() === str.toLowerCase() || x.value === str,
        );
        if (!r)
          return {
            ...out,
            ok: false,
            error: `Option "${str}" not found (options: ${info.options?.join(', ')})`,
          };
        r.click();
        return { ...out, ok: true };
      }
      case 'checkbox': {
        const b = cell.querySelector<HTMLInputElement>('input[type=checkbox]')!;
        if (b.checked !== truthy(value)) b.click();
        return { ...out, ok: true };
      }
      case 'checklist': {
        const wanted = asList(value).map((x) => x.toLowerCase());
        const boxes = Array.from(cell.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
        const missing = wanted.filter((x) => !boxes.some((b) => labelText(b).toLowerCase() === x));
        if (missing.length)
          return { ...out, ok: false, error: `Options not found: ${missing.join(', ')}` };
        boxes.forEach((b) => {
          const want = wanted.includes(labelText(b).toLowerCase());
          if (b.checked !== want) b.click();
        });
        return { ...out, ok: true };
      }
      case 'date': {
        const picker = datePicker(cell);
        if (str === '') {
          picker?.clear?.();
          return { ...out, ok: true };
        }
        const d = new Date(str);
        if (isNaN(d.getTime())) return { ...out, ok: false, error: `Invalid date "${str}"` };
        if (picker?.set_selectedDate) picker.set_selectedDate(d);
        else {
          const input = cell.querySelector<HTMLInputElement>('input[id$="_dateInput"]')!;
          input.value = d.toLocaleDateString('en-US');
          fire(input);
        }
        return { ...out, ok: true };
      }
      case 'combo': {
        const combo = radCombo(cell);
        if (!combo) return { ...out, ok: false, error: 'Combo box is not initialised' };
        if (str === '') {
          combo.clearSelection?.();
          return { ...out, ok: true };
        }
        const item = combo.findItemByText?.(str) ?? combo.findItemByValue?.(str);
        if (item) {
          item.select();
          return { ...out, ok: true };
        }
        if (combo.get_allowCustomText?.()) {
          combo.set_text(str);
          return { ...out, ok: true };
        }
        return { ...out, ok: false, error: `Option "${str}" not found in the list` };
      }
      default:
        return { ...out, ok: false, error: `Setting ${info.type} fields is not supported` };
    }
  };

  /** Visible validation messages and the page banner. */
  const errors = () => {
    const msgs = Array.from(
      document.querySelectorAll(
        '.ValidatorText, span[id*="Validator"], .validation-summary-errors, [id$="lblError"]',
      ),
    )
      .filter(visible)
      .map((e) => clean(e.textContent))
      .filter((t) => t && t !== '*');
    // Confirmation lives in divSavedMessage; server-side errors in divMessageSummary*.
    const byId = (suffix: string) => {
      const el = document.querySelector(`[id$="${suffix}"]`);
      return el && visible(el) ? clean(el.textContent).replace(/^×\s*/, '') : '';
    };
    // InstanceDetails: divSavedMessage. StartProcess: divFormSubmitMessage (submit) / divSavedMessage (draft).
    const saved = byId('_divFormSubmitMessage') || byId('_divSavedMessage');
    const summary = [byId('_divMessageSummaryHeader'), byId('_divMessageSummaryContent')]
      .filter(Boolean)
      .join(' ');
    if (summary) msgs.unshift(summary);
    return { banner: saved || summary || null, messages: Array.from(new Set(msgs)) };
  };

  /** Validates a write without touching the form (no clicks, so no auto-postbacks). */
  const check = (key: string, value: unknown) => {
    const { row, error } = find(key);
    if (!row) return { field: key, ok: false, error };
    const info: any = inspect(row);
    const out = { field: key, label: row.label, type: info.type };
    if (!info.editable) {
      return {
        ...out,
        ok: false,
        error: `Field "${row.label}" is not editable on this step (${info.type})`,
      };
    }
    if (['file', 'readonly'].includes(info.type)) {
      return { ...out, ok: false, error: `Setting ${info.type} fields is not supported` };
    }
    const str = value === null || value === undefined ? '' : String(value);
    if (str && ['radio', 'select'].includes(info.type) && info.options) {
      const hit = (info.options as string[]).some((o) => o.toLowerCase() === str.toLowerCase());
      if (!hit)
        return {
          ...out,
          ok: false,
          error: `Option "${str}" not found (options: ${info.options.join(', ')})`,
        };
    }
    if (['checklist', 'multiselect'].includes(info.type) && info.options) {
      const missing = asList(value).filter(
        (x) => !(info.options as string[]).some((o) => o.toLowerCase() === x.toLowerCase()),
      );
      if (missing.length)
        return { ...out, ok: false, error: `Options not found: ${missing.join(', ')}` };
    }
    if (info.type === 'date' && str && isNaN(new Date(str).getTime())) {
      return { ...out, ok: false, error: `Invalid date "${str}"` };
    }
    return { ...out, ok: true };
  };

  w.__ebForm = {
    check: (values: Record<string, unknown>) => Object.entries(values).map(([k, v]) => check(k, v)),
    read: () => rows().map(inspect),
    write: (values: Record<string, unknown>) => Object.entries(values).map(([k, v]) => write(k, v)),
    errors,
  };
}

export async function installFormHelper(page: puppeteer.Page): Promise<void> {
  await page.evaluate(formHelper);
}

export async function readFormFields(page: puppeteer.Page): Promise<ProcessField[]> {
  await installFormHelper(page);
  return await page.evaluate(() => (window as any).__ebForm.read());
}

export async function writeFormFields(
  page: puppeteer.Page,
  values: Record<string, FieldInputValue>,
): Promise<FieldWriteResult[]> {
  await installFormHelper(page);
  return await page.evaluate((v) => (window as any).__ebForm.write(v), values);
}

export async function readFormErrors(
  page: puppeteer.Page,
): Promise<{ banner: string | null; messages: string[] }> {
  await installFormHelper(page);
  return await page.evaluate(() => (window as any).__ebForm.errors());
}

/** Checks that every field exists, is editable, and accepts the value, without writing. */
export async function checkFormFields(
  page: puppeteer.Page,
  values: Record<string, FieldInputValue>,
): Promise<FieldWriteResult[]> {
  await installFormHelper(page);
  return await page.evaluate((v) => (window as any).__ebForm.check(v), values);
}
