import puppeteer from 'puppeteer';
import { baseurl, BrowserManager, Environment } from './index.js';

type SetProcessInstanceNullFieldsArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  processInstanceId: string;
  fieldNames: string[];
  dryRun?: boolean;
  processUrlTemplate?: string;
};

export type SetProcessInstanceNullFieldsResult = {
  processInstanceId: string;
  visitedUrl: string;
  clearedFields: string[];
  notFoundFields: string[];
};

export function buildProcessInstanceUrl(
  processUrlTemplate: string,
  env: Environment,
  processInstanceId: string,
): string {
  return processUrlTemplate.replaceAll('{env}', env).replaceAll('{id}', processInstanceId);
}

export async function clearFieldsByNames(
  page: puppeteer.Page,
  fieldNames: string[],
): Promise<{ clearedFields: string[]; notFoundFields: string[] }> {
  return await page.evaluate((names) => {
    const normalizeText = (value: string | null | undefined): string => {
      if (!value) return '';
      return value
        .toLowerCase()
        .replace(/&nbsp;/g, ' ')
        .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ')
        .replace(/[†*:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const cleanLabel = (value: string | null | undefined): string => {
      const norm = normalizeText(value);
      return norm
        .replace(/^(?:\d+[\s.)-]+|[•\-*]\s*)/, '')
        .replace(/[?:*!]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const superClean = (value: string | null | undefined): string => {
      return cleanLabel(value).replace(/[^a-z0-9]/g, '');
    };

    const isFieldControl = (
      el: Element | null,
    ): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
      if (!el) return false;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      );
    };

    const fireEvents = (el: HTMLElement): void => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const clearNativeInput = (input: HTMLInputElement): void => {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        input.checked = false;
        input.defaultChecked = false;
      } else {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(input, '');
        input.value = '';
        input.defaultValue = '';
      }
      fireEvents(input);
    };

    const clearSelect = (select: HTMLSelectElement): void => {
      if (select.multiple) {
        for (const option of Array.from(select.options)) {
          option.selected = false;
        }
        select.selectedIndex = -1;
      } else {
        const emptyOption = Array.from(select.options).find(
          (option) =>
            option.value === '' ||
            option.text.trim() === '' ||
            /^--\s*select|^select|^none/i.test(option.text.trim()),
        );
        if (emptyOption) {
          select.value = emptyOption.value;
          emptyOption.selected = true;
        } else {
          select.selectedIndex = -1;
          select.value = '';
        }
      }
      fireEvents(select);
    };

    const clearTelerikRadComboBox = (container: Element): boolean => {
      let cleared = false;
      const combos = Array.from(
        container.querySelectorAll('.RadComboBox, [id$="_Input"], [id$="_DropDown"]'),
      );

      const baseIds = new Set<string>();
      for (const el of combos) {
        if (el.id) {
          const baseId = el.id.replace(/_Input$|_DropDown$|_Arrow$|_wrapper$/, '');
          baseIds.add(baseId);
        }
      }

      for (const baseId of baseIds) {
        const comboObj = (window as any).$find ? (window as any).$find(baseId) : null;
        if (comboObj) {
          try {
            if (typeof comboObj.clearSelection === 'function') comboObj.clearSelection();
            if (typeof comboObj.set_text === 'function') comboObj.set_text('');
            if (typeof comboObj.set_value === 'function') comboObj.set_value('');
            if (typeof comboObj.commitChanges === 'function') comboObj.commitChanges();
          } catch {}
          cleared = true;
        }

        const visibleInput = document.getElementById(`${baseId}_Input`) as HTMLInputElement | null;
        if (visibleInput) {
          clearNativeInput(visibleInput);
          cleared = true;
        }

        const valueInput = (document.getElementById(`${baseId}_Value`) ||
          container.querySelector(`input[name$="${baseId}_Value"]`)) as HTMLInputElement | null;
        if (valueInput) {
          valueInput.value = '';
          cleared = true;
        }

        const clientState = (document.getElementById(`${baseId}_ClientState`) ||
          container.querySelector(
            `input[name$="${baseId}_ClientState"]`,
          )) as HTMLInputElement | null;
        if (clientState) {
          clientState.value = '{"logEntries":[],"value":"","text":""}';
          cleared = true;
        }
      }

      return cleared;
    };

    const clearTelerikRadNumericOrInput = (container: Element): boolean => {
      let cleared = false;
      const radInputs = Array.from(
        container.querySelectorAll('.RadInput, .riTextBox, [id$="_text"], [id$="_ClientState"]'),
      );

      const baseIds = new Set<string>();
      for (const el of radInputs) {
        if (el.id) {
          const baseId = el.id.replace(/_wrapper$|_text$|_ClientState$|_Value$/, '');
          baseIds.add(baseId);
        }
      }

      for (const baseId of baseIds) {
        const radObj = (window as any).$find ? (window as any).$find(baseId) : null;
        if (radObj) {
          try {
            if (typeof radObj.clear === 'function') radObj.clear();
            if (typeof radObj.set_value === 'function') radObj.set_value('');
          } catch {}
          cleared = true;
        }

        const textInput = (document.getElementById(`${baseId}_text`) ||
          document.getElementById(baseId)) as HTMLInputElement | null;
        if (textInput && textInput.type !== 'hidden') {
          clearNativeInput(textInput);
          cleared = true;
        }

        const rawInput = document.getElementById(baseId) as HTMLInputElement | null;
        if (rawInput && rawInput !== textInput) {
          rawInput.value = '';
          cleared = true;
        }

        const valInput = document.getElementById(`${baseId}_Value`) as HTMLInputElement | null;
        if (valInput) {
          valInput.value = '';
          cleared = true;
        }

        const clientState = document.getElementById(
          `${baseId}_ClientState`,
        ) as HTMLInputElement | null;
        if (clientState) {
          clientState.value =
            '{"enabled":true,"emptyMessage":"","validationText":"","valueAsString":"","lastValueAsString":""}';
          cleared = true;
        }
      }

      return cleared;
    };

    const clearTelerikRadDatePicker = (container: Element): boolean => {
      let cleared = false;
      const dateInputs = Array.from(
        container.querySelectorAll('input[id$="_dateInput"], [id$="_rdpDate_wrapper"], .RadPicker'),
      );

      const baseIds = new Set<string>();
      for (const el of dateInputs) {
        if (el.id) {
          const baseId = el.id.replace(
            /_dateInput$|_wrapper$|_dateInput_ClientState$|_ClientState$/,
            '',
          );
          baseIds.add(baseId);
        }
      }

      for (const baseId of baseIds) {
        const pickerObj = (window as any).$find ? (window as any).$find(baseId) : null;
        if (pickerObj) {
          try {
            if (typeof pickerObj.clear === 'function') pickerObj.clear();
            if (typeof pickerObj.set_selectedDate === 'function') pickerObj.set_selectedDate(null);
          } catch {}
          cleared = true;
        }

        const dateInputEl = document.getElementById(
          `${baseId}_dateInput`,
        ) as HTMLInputElement | null;
        if (dateInputEl) {
          clearNativeInput(dateInputEl);
          cleared = true;
        }

        const rawDateEl = document.getElementById(baseId) as HTMLInputElement | null;
        if (rawDateEl) {
          rawDateEl.value = '';
          cleared = true;
        }

        const dateClientState = document.getElementById(
          `${baseId}_dateInput_ClientState`,
        ) as HTMLInputElement | null;
        if (dateClientState) {
          dateClientState.value = '';
          cleared = true;
        }

        const pickerClientState = document.getElementById(
          `${baseId}_ClientState`,
        ) as HTMLInputElement | null;
        if (pickerClientState) {
          pickerClientState.value = '';
          cleared = true;
        }
      }

      return cleared;
    };

    const clearRichTextOrEditor = (container: Element): boolean => {
      let cleared = false;
      const editors = Array.from(container.querySelectorAll('.RadEditor, [id$="_RadEditor"]'));
      for (const el of editors) {
        if (el.id) {
          const editorObj = (window as any).$find ? (window as any).$find(el.id) : null;
          if (editorObj && typeof editorObj.set_html === 'function') {
            try {
              editorObj.set_html('');
              cleared = true;
            } catch {}
          }
        }
      }

      const iframes = Array.from(container.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        try {
          if (iframe.contentDocument?.body) {
            iframe.contentDocument.body.innerHTML = '';
            cleared = true;
          }
        } catch {}
      }

      const editables = Array.from(container.querySelectorAll('[contenteditable="true"]'));
      for (const editable of editables) {
        (editable as HTMLElement).innerHTML = '';
        cleared = true;
      }

      return cleared;
    };

    const clearLookupOrAttachment = (container: Element): boolean => {
      let cleared = false;

      const removeControls = Array.from(
        container.querySelectorAll('a, button, input[type="button"], img, span[role="button"]'),
      ).filter((el) => {
        const text = normalizeText(el.textContent);
        const onclick = normalizeText(el.getAttribute('onclick'));
        const title = normalizeText(el.getAttribute('title'));
        const ariaLabel = normalizeText(el.getAttribute('aria-label'));
        const alt = normalizeText(el.getAttribute('alt'));
        const combined = `${text} ${onclick} ${title} ${ariaLabel} ${alt}`;
        return (
          combined.includes('remove') ||
          combined.includes('clear') ||
          combined.includes('delete') ||
          combined.includes('deletefile') ||
          combined.includes('reset')
        );
      });

      for (const ctrl of removeControls) {
        if ((ctrl as HTMLElement).offsetParent === null) continue;
        try {
          (ctrl as HTMLElement).click();
          cleared = true;
        } catch {}
      }

      const displaySpans = Array.from(
        container.querySelectorAll(
          'span[id$="_lblText"], span[id$="_lblName"], span[id$="_lblSelected"], span.lookup-display',
        ),
      );
      for (const span of displaySpans) {
        if (span.textContent?.trim()) {
          span.textContent = '';
          cleared = true;
        }
      }

      return cleared;
    };

    const clearByRow = (row: Element): boolean => {
      let cleared = false;
      const detailsCell = row.querySelector('td.Details, td.details') ?? row;

      if (clearTelerikRadComboBox(detailsCell)) cleared = true;
      if (clearTelerikRadNumericOrInput(detailsCell)) cleared = true;
      if (clearTelerikRadDatePicker(detailsCell)) cleared = true;
      if (clearRichTextOrEditor(detailsCell)) cleared = true;
      if (clearLookupOrAttachment(detailsCell)) cleared = true;

      const radios = Array.from(
        detailsCell.querySelectorAll('input[type="radio"]'),
      ) as HTMLInputElement[];
      for (const radio of radios) {
        if (radio.checked) {
          radio.checked = false;
          radio.defaultChecked = false;
          fireEvents(radio);
          cleared = true;
        }
      }

      const checkboxes = Array.from(
        detailsCell.querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      for (const cb of checkboxes) {
        if (cb.checked) {
          cb.checked = false;
          cb.defaultChecked = false;
          fireEvents(cb);
          cleared = true;
        }
      }

      const selects = Array.from(detailsCell.querySelectorAll('select')) as HTMLSelectElement[];
      for (const select of selects) {
        clearSelect(select);
        cleared = true;
      }

      const textareas = Array.from(
        detailsCell.querySelectorAll('textarea'),
      ) as HTMLTextAreaElement[];
      for (const textarea of textareas) {
        textarea.value = '';
        textarea.defaultValue = '';
        fireEvents(textarea);
        cleared = true;
      }

      const textInputs = Array.from(detailsCell.querySelectorAll('input')) as HTMLInputElement[];
      for (const input of textInputs) {
        const type = input.type.toLowerCase();
        if (
          input.disabled ||
          type === 'hidden' ||
          type === 'radio' ||
          type === 'checkbox' ||
          type === 'button' ||
          type === 'submit'
        ) {
          continue;
        }

        clearNativeInput(input);
        cleared = true;
      }

      const hiddenInputs = Array.from(
        detailsCell.querySelectorAll('input[type="hidden"]'),
      ) as HTMLInputElement[];
      for (const hiddenInput of hiddenInputs) {
        const id = (hiddenInput.id || '').toLowerCase();
        const name = (hiddenInput.name || '').toLowerCase();
        if (
          id.includes('__viewstate') ||
          id.includes('__eventvalidation') ||
          id.includes('__asyncpost') ||
          name.includes('__viewstate') ||
          name.includes('__eventvalidation')
        ) {
          continue;
        }

        if (hiddenInput.value !== '') {
          hiddenInput.value = '';
          cleared = true;
        }
      }

      return cleared;
    };

    const isControlBlank = (
      control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ): boolean => {
      if (control instanceof HTMLSelectElement) {
        return (
          control.value.trim() === '' ||
          control.selectedIndex < 0 ||
          /^--\s*select|^select|^none/i.test(
            control.options[control.selectedIndex]?.text?.trim() ?? '',
          )
        );
      }

      if (control instanceof HTMLTextAreaElement) {
        return control.value.trim() === '';
      }

      const type = control.type.toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        return !control.checked;
      }

      return control.value.trim() === '';
    };

    const isRowBlank = (row: Element): boolean => {
      const detailsCell = row.querySelector('td.Details, td.details') ?? row;

      const controls = Array.from(
        detailsCell.querySelectorAll(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select',
        ),
      ).filter(isFieldControl);

      for (const ctrl of controls) {
        if (!isControlBlank(ctrl)) return false;
      }

      const rcbValues = Array.from(
        detailsCell.querySelectorAll('input[id$="_Value"]'),
      ) as HTMLInputElement[];
      for (const rcbVal of rcbValues) {
        if (rcbVal.value.trim() !== '') return false;
      }

      const displaySpans = Array.from(
        detailsCell.querySelectorAll(
          'span[id$="_lblText"], span[id$="_lblName"], span[id$="_lblSelected"], span.lookup-display',
        ),
      );
      for (const span of displaySpans) {
        if (span.textContent?.trim() !== '') return false;
      }

      return true;
    };

    const dataFieldsContainer =
      document.getElementById('ctl00_contentSection_dataFields') ||
      document.querySelector('[id$="_dataFields"]') ||
      document;

    const findRowsByFieldName = (fieldName: string): Element[] => {
      const targetNorm = normalizeText(fieldName);
      const targetClean = cleanLabel(fieldName);
      const targetSuper = superClean(fieldName);

      const rows = Array.from(dataFieldsContainer.querySelectorAll('tr'));
      const matchesWithScore: Array<{ row: Element; score: number }> = [];

      for (const row of rows) {
        const labelCell = row.querySelector(
          'td.Label, th.Label, td[class*="Label" i], th[class*="Label" i], td[class*="label" i]',
        );
        if (!labelCell) continue;

        const cellNorm = normalizeText(labelCell.textContent);
        const cellClean = cleanLabel(labelCell.textContent);
        const cellSuper = superClean(labelCell.textContent);

        let score = 0;
        if (cellNorm === targetNorm && targetNorm.length > 0) {
          score = 100;
        } else if (cellClean === targetClean && targetClean.length > 0) {
          score = 90;
        } else if (cellSuper === targetSuper && targetSuper.length > 0) {
          score = 80;
        } else if (
          targetClean.length > 3 &&
          (cellClean.startsWith(targetClean) || targetClean.startsWith(cellClean))
        ) {
          score = 70;
        }

        if (score > 0) {
          matchesWithScore.push({ row, score });
        }
      }

      if (matchesWithScore.length === 0) {
        const allLabels = Array.from(document.querySelectorAll('label'));
        for (const lbl of allLabels) {
          const lblNorm = normalizeText(lbl.textContent);
          const lblClean = cleanLabel(lbl.textContent);
          const lblSuper = superClean(lbl.textContent);

          let score = 0;
          if (lblNorm === targetNorm && targetNorm.length > 0) {
            score = 95;
          } else if (lblClean === targetClean && targetClean.length > 0) {
            score = 85;
          } else if (lblSuper === targetSuper && targetSuper.length > 0) {
            score = 75;
          }

          if (score > 0) {
            const container = lbl.closest('tr, li, .form-group, .field, td, div');
            if (container) {
              matchesWithScore.push({ row: container, score });
            }
          }
        }
      }

      return matchesWithScore.sort((a, b) => b.score - a.score).map((m) => m.row);
    };

    const clearedFields: string[] = [];
    const notFoundFields: string[] = [];

    for (const fieldName of names) {
      const rows = findRowsByFieldName(fieldName);
      if (rows.length > 0) {
        let anyRowCleared = false;
        for (const row of rows) {
          if (clearByRow(row)) {
            anyRowCleared = true;
          }
        }

        if (anyRowCleared || rows.some(isRowBlank)) {
          clearedFields.push(fieldName);
          continue;
        }
      }

      const targetNorm = normalizeText(fieldName);
      const allControls = Array.from(
        dataFieldsContainer.querySelectorAll('input:not([type="hidden"]), textarea, select'),
      ).filter(isFieldControl);

      let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
      for (const ctrl of allControls) {
        const attributes = [
          ctrl.id,
          ctrl.getAttribute('name'),
          ctrl.getAttribute('aria-label'),
          ctrl.getAttribute('placeholder'),
          ctrl.getAttribute('title'),
          (ctrl as HTMLInputElement).labels?.[0]?.textContent ?? null,
        ];

        for (const attr of attributes) {
          if (normalizeText(attr) === targetNorm || cleanLabel(attr) === cleanLabel(fieldName)) {
            control = ctrl;
            break;
          }
        }
        if (control) break;
      }

      if (!control) {
        notFoundFields.push(fieldName);
        continue;
      }

      if (control instanceof HTMLSelectElement) {
        clearSelect(control);
      } else if (control instanceof HTMLTextAreaElement) {
        control.value = '';
        fireEvents(control);
      } else {
        clearNativeInput(control);
      }
      clearedFields.push(fieldName);
    }

    return { clearedFields, notFoundFields };
  }, fieldNames);
}

export async function findFieldsStillPopulated(
  page: puppeteer.Page,
  fieldNames: string[],
): Promise<string[]> {
  return await page.evaluate((names) => {
    const normalizeText = (value: string | null | undefined): string => {
      if (!value) return '';
      return value
        .toLowerCase()
        .replace(/&nbsp;/g, ' ')
        .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ')
        .replace(/[†*:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const cleanLabel = (value: string | null | undefined): string => {
      const norm = normalizeText(value);
      return norm
        .replace(/^(?:\d+[\s.)-]+|[•\-*]\s*)/, '')
        .replace(/[?:*!]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const superClean = (value: string | null | undefined): string => {
      return cleanLabel(value).replace(/[^a-z0-9]/g, '');
    };

    const isFieldControl = (
      el: Element | null,
    ): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
      if (!el) return false;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      );
    };

    const isControlBlank = (
      control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ): boolean => {
      if (control instanceof HTMLSelectElement) {
        return (
          control.value.trim() === '' ||
          control.selectedIndex < 0 ||
          /^--\s*select|^select|^none/i.test(
            control.options[control.selectedIndex]?.text?.trim() ?? '',
          )
        );
      }

      if (control instanceof HTMLTextAreaElement) {
        return control.value.trim() === '';
      }

      const type = control.type.toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        return !control.checked;
      }

      return control.value.trim() === '';
    };

    const isRowBlank = (row: Element): boolean => {
      const detailsCell = row.querySelector('td.Details, td.details') ?? row;

      const controls = Array.from(
        detailsCell.querySelectorAll(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select',
        ),
      ).filter(isFieldControl);

      for (const ctrl of controls) {
        if (!isControlBlank(ctrl)) return false;
      }

      const rcbValues = Array.from(
        detailsCell.querySelectorAll('input[id$="_Value"]'),
      ) as HTMLInputElement[];
      for (const rcbVal of rcbValues) {
        if (rcbVal.value.trim() !== '') return false;
      }

      const displaySpans = Array.from(
        detailsCell.querySelectorAll(
          'span[id$="_lblText"], span[id$="_lblName"], span[id$="_lblSelected"], span.lookup-display',
        ),
      );
      for (const span of displaySpans) {
        if (span.textContent?.trim() !== '') return false;
      }

      return true;
    };

    const dataFieldsContainer =
      document.getElementById('ctl00_contentSection_dataFields') ||
      document.querySelector('[id$="_dataFields"]') ||
      document;

    const findRowsByFieldName = (fieldName: string): Element[] => {
      const targetNorm = normalizeText(fieldName);
      const targetClean = cleanLabel(fieldName);
      const targetSuper = superClean(fieldName);

      const rows = Array.from(dataFieldsContainer.querySelectorAll('tr'));
      const matches: Element[] = [];

      for (const row of rows) {
        const labelCell = row.querySelector(
          'td.Label, th.Label, td[class*="Label" i], th[class*="Label" i], td[class*="label" i]',
        );
        if (!labelCell) continue;

        const cellNorm = normalizeText(labelCell.textContent);
        const cellClean = cleanLabel(labelCell.textContent);
        const cellSuper = superClean(labelCell.textContent);

        if (
          (cellNorm === targetNorm && targetNorm.length > 0) ||
          (cellClean === targetClean && targetClean.length > 0) ||
          (cellSuper === targetSuper && targetSuper.length > 0)
        ) {
          matches.push(row);
        }
      }

      return matches;
    };

    const fieldsStillPopulated: string[] = [];

    for (const fieldName of names) {
      const rows = findRowsByFieldName(fieldName);
      if (rows.length > 0) {
        const anyPopulated = rows.some((row) => !isRowBlank(row));
        if (anyPopulated) {
          fieldsStillPopulated.push(fieldName);
        }
        continue;
      }

      const targetNorm = normalizeText(fieldName);
      const allControls = Array.from(
        dataFieldsContainer.querySelectorAll('input:not([type="hidden"]), textarea, select'),
      ).filter(isFieldControl);

      const control = allControls.find((ctrl) => {
        const attributes = [
          ctrl.id,
          ctrl.getAttribute('name'),
          ctrl.getAttribute('aria-label'),
          ctrl.getAttribute('placeholder'),
          ctrl.getAttribute('title'),
          (ctrl as HTMLInputElement).labels?.[0]?.textContent ?? null,
        ];
        return attributes.some(
          (attr) =>
            normalizeText(attr) === targetNorm || cleanLabel(attr) === cleanLabel(fieldName),
        );
      });

      if (control && !isControlBlank(control)) {
        fieldsStillPopulated.push(fieldName);
      }
    }

    return fieldsStillPopulated;
  }, fieldNames);
}

async function clickSave(page: puppeteer.Page): Promise<void> {
  await waitForProcessFormToSettle(page);

  const exactSaveSelectors = [
    '#ctl00_contentSection_btnSave',
    'input[name="ctl00$contentSection$btnSave"]',
    'input[id="ctl00_contentSection_btnSave"]',
  ];

  let saveFound = false;

  for (const selector of exactSaveSelectors) {
    const match = await page.$(selector);
    if (!match) continue;

    saveFound = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => null),
      match.click(),
    ]);
    break;
  }

  if (!saveFound) {
    const saveHandle = await page.evaluateHandle(() => {
      const controls = Array.from(
        document.querySelectorAll('button, input[type="button"], input[type="submit"]'),
      );
      return (
        controls.find((el) => {
          const id = (el.getAttribute('id') ?? '').toLowerCase();
          const name = (el.getAttribute('name') ?? '').toLowerCase();
          const text = ((el.textContent ?? '') || (el.getAttribute('value') ?? ''))
            .trim()
            .toLowerCase();
          return (
            id.includes('save') || name.includes('save') || text === 'save' || text.includes('save')
          );
        }) ?? null
      );
    });

    const saveElement = saveHandle.asElement() as puppeteer.ElementHandle<HTMLElement> | null;
    if (!saveElement) {
      throw new Error('Save button not found on process instance form.');
    }

    saveFound = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => null),
      saveElement.click(),
    ]);
  }

  await waitForProcessFormToSettle(page);
}

async function waitForProcessFormToSettle(page: puppeteer.Page): Promise<void> {
  await page
    .waitForSelector('#ctl00_contentSection_dataFields', {
      timeout: 10_000,
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const isDocumentReady = document.readyState === 'complete';

        const pageRequestManager = (
          window as any
        ).Sys?.WebForms?.PageRequestManager?.getInstance?.();
        const isAspNetPostBackIdle = !(pageRequestManager?.get_isInAsyncPostBack?.() ?? false);

        const isJQueryIdle =
          typeof (window as any).jQuery === 'undefined' ||
          ((window as any).jQuery.active ?? 0) === 0;

        return isDocumentReady && isAspNetPostBackIdle && isJQueryIdle;
      },
      {
        timeout: 15_000,
      },
    )
    .catch(() => null);

  await new Promise((resolve) => setTimeout(resolve, 300));

  await page
    .waitForFunction(
      () => {
        const pageRequestManager = (
          window as any
        ).Sys?.WebForms?.PageRequestManager?.getInstance?.();
        const isAspNetPostBackIdle = !(pageRequestManager?.get_isInAsyncPostBack?.() ?? false);

        const isJQueryIdle =
          typeof (window as any).jQuery === 'undefined' ||
          ((window as any).jQuery.active ?? 0) === 0;

        return isAspNetPostBackIdle && isJQueryIdle;
      },
      {
        timeout: 15_000,
      },
    )
    .catch(() => null);

  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8_000 }).catch(() => null);
}

export async function isAuthenticatedProcessPage(page: puppeteer.Page): Promise<boolean> {
  const currentUrl = page.url().toLowerCase();
  if (
    currentUrl.includes('/login') ||
    currentUrl.includes('signin') ||
    currentUrl.includes('session') ||
    currentUrl.includes('/account/')
  ) {
    return false;
  }

  const pageSignals = await page.evaluate(() => {
    const hasDataFieldsSection = Boolean(
      document.querySelector('#ctl00_contentSection_dataFields'),
    );
    const hasDataFieldRows =
      document.querySelectorAll('#ctl00_contentSection_dataFields td.Label').length > 0;
    const hasProcessTitle = /process|instance details/i.test(document.title || '');
    return {
      hasDataFieldsSection,
      hasDataFieldRows,
      hasProcessTitle,
    };
  });

  return (
    pageSignals.hasDataFieldsSection || pageSignals.hasDataFieldRows || pageSignals.hasProcessTitle
  );
}

export async function setProcessInstanceFieldsToNull(
  options: SetProcessInstanceNullFieldsArgs,
): Promise<SetProcessInstanceNullFieldsResult> {
  const {
    env,
    cookies,
    browser,
    processInstanceId,
    fieldNames,
    dryRun = false,
    processUrlTemplate = `https://{env}.${baseurl}/da2/processes/instancedetails.aspx?instanceid={id}&AF=1`,
  } = options;

  if (!fieldNames.length) {
    throw new Error('At least one field name is required.');
  }

  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());
  const requestedUrl = buildProcessInstanceUrl(processUrlTemplate, env, processInstanceId);
  let visitedUrl = requestedUrl;
  let page: puppeteer.Page | null = null;

  try {
    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);
    page = await context.newPage();

    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch {}
    });

    await page.goto(requestedUrl, { waitUntil: 'networkidle0' });
    visitedUrl = page.url();

    if (!(await isAuthenticatedProcessPage(page))) {
      throw new Error(
        `Session is not active on the process instance page. Requested URL: ${requestedUrl}. Final URL: ${page.url()}.`,
      );
    }

    await waitForProcessFormToSettle(page);

    const { clearedFields, notFoundFields } = await clearFieldsByNames(page, fieldNames);

    await waitForProcessFormToSettle(page);

    let fieldsStillPopulated = await findFieldsStillPopulated(page, clearedFields);

    let retryCount = 0;
    while (fieldsStillPopulated.length > 0 && retryCount < 3) {
      retryCount++;
      await clearFieldsByNames(page, fieldsStillPopulated);
      await waitForProcessFormToSettle(page);
      fieldsStillPopulated = await findFieldsStillPopulated(page, clearedFields);
    }

    if (fieldsStillPopulated.length > 0) {
      throw new Error(
        `Refusing to save because some fields are still populated: ${fieldsStillPopulated.join(', ')}`,
      );
    }

    if (!dryRun && clearedFields.length > 0) {
      await clickSave(page);
    }

    return {
      processInstanceId,
      visitedUrl,
      clearedFields,
      notFoundFields,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore page-close errors.
      }
    }
  }
}
