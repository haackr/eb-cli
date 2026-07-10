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

function buildProcessInstanceUrl(
  processUrlTemplate: string,
  env: Environment,
  processInstanceId: string,
): string {
  return processUrlTemplate.replaceAll('{env}', env).replaceAll('{id}', processInstanceId);
}

async function clearFieldsByNames(
  page: puppeteer.Page,
  fieldNames: string[],
): Promise<{ clearedFields: string[]; notFoundFields: string[] }> {
  return await page.evaluate((names) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? '').trim().toLowerCase().replaceAll(/\s+/g, ' ');

    const cleanLabel = (value: string | null | undefined): string => {
      const normalized = normalize(value).replace(/:$/g, '').replace(/\?$/g, '').trim();
      return normalized;
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

    const clearInput = (input: HTMLInputElement): void => {
      const type = input.type.toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        input.checked = false;
      } else {
        input.value = '';
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
        const emptyOption = Array.from(select.options).find((option) => option.value === '');
        if (emptyOption) {
          select.value = '';
        } else {
          select.selectedIndex = -1;
        }
      }
      fireEvents(select);
    };

    const clearDateInputCompanions = (row: Element): void => {
      const dateInputs = Array.from(
        row.querySelectorAll('input[id$="_dateInput"]'),
      ) as HTMLInputElement[];

      for (const dateInput of dateInputs) {
        dateInput.value = '';
        fireEvents(dateInput);

        const wrapper = dateInput.closest('[id$="_wrapper"]');
        if (!wrapper) continue;

        const rawId = wrapper.id.replace(/_wrapper$/, '');
        const hiddenRaw = document.getElementById(rawId);
        if (hiddenRaw instanceof HTMLInputElement) {
          hiddenRaw.value = '';
          fireEvents(hiddenRaw);
        }

        const clientState = document.getElementById(`${rawId}_dateInput_ClientState`);
        if (clientState instanceof HTMLInputElement) {
          clientState.value = '';
        }
      }
    };

    const clearLookupOrFileCompanions = (row: Element): boolean => {
      let cleared = false;

      const removeLinks = Array.from(row.querySelectorAll('a')).filter((a) => {
        const text = normalize(a.textContent);
        const onclick = normalize(a.getAttribute('onclick'));
        return (
          text.includes('remove') || onclick.includes('clear') || onclick.includes('deletefile')
        );
      });

      for (const link of removeLinks) {
        if ((link as HTMLElement).offsetParent === null) continue;
        (link as HTMLElement).click();
        cleared = true;
      }

      const hiddenInputs = Array.from(
        row.querySelectorAll('input[type="hidden"]'),
      ) as HTMLInputElement[];
      for (const hiddenInput of hiddenInputs) {
        if (hiddenInput.value !== '') {
          hiddenInput.value = '';
          fireEvents(hiddenInput);
          cleared = true;
        }
      }

      const disabledTextInputs = Array.from(
        row.querySelectorAll('input[type="text"][disabled]'),
      ) as HTMLInputElement[];
      for (const disabledTextInput of disabledTextInputs) {
        if (disabledTextInput.value !== '') {
          disabledTextInput.value = '';
          fireEvents(disabledTextInput);
          cleared = true;
        }
      }

      return cleared;
    };

    const clearByRow = (row: Element): boolean => {
      let cleared = false;

      const detailsCell = row.querySelector('td.Details') ?? row;

      const radios = Array.from(
        detailsCell.querySelectorAll('input[type="radio"]'),
      ) as HTMLInputElement[];
      if (radios.length > 0) {
        for (const radio of radios) {
          if (radio.checked) {
            radio.checked = false;
            fireEvents(radio);
            cleared = true;
          }
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

        clearInput(input);
        cleared = true;
      }

      clearDateInputCompanions(detailsCell);
      if (detailsCell.querySelector('input[id$="_dateInput"]')) {
        cleared = true;
      }

      if (clearLookupOrFileCompanions(detailsCell)) {
        cleared = true;
      }

      return cleared;
    };

    const dataFieldsContainer =
      document.getElementById('ctl00_contentSection_dataFields') ?? document;

    const findRowByFieldName = (fieldName: string): Element | null => {
      const target = cleanLabel(fieldName);
      const rows = Array.from(dataFieldsContainer.querySelectorAll('tr'));

      for (const row of rows) {
        const labelCell = row.querySelector('td.Label');
        if (!labelCell) continue;

        const labelText = cleanLabel(labelCell.textContent);
        if (!labelText) continue;

        if (labelText === target || labelText.includes(target) || target.includes(labelText)) {
          return row;
        }
      }

      return null;
    };

    const allControls = Array.from(
      dataFieldsContainer.querySelectorAll('input:not([type="hidden"]), textarea, select'),
    ).filter(isFieldControl);

    const findControlByAttributes = (
      name: string,
    ): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
      const target = normalize(name);

      for (const control of allControls) {
        const attributes = [
          control.id,
          control.getAttribute('name'),
          control.getAttribute('aria-label'),
          control.getAttribute('placeholder'),
          control.getAttribute('title'),
          (control as HTMLInputElement).labels?.[0]?.textContent ?? null,
        ];

        for (const attr of attributes) {
          const normalizedAttr = normalize(attr);
          if (!normalizedAttr) continue;
          if (
            normalizedAttr === target ||
            normalizedAttr.includes(target) ||
            target.includes(normalizedAttr)
          ) {
            return control;
          }
        }
      }

      return null;
    };

    const findControlByLabel = (
      name: string,
    ): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
      const target = normalize(name);
      const labels = Array.from(document.querySelectorAll('label'));

      for (const label of labels) {
        const labelText = normalize(label.textContent);
        if (!(labelText === target || labelText.includes(target) || target.includes(labelText))) {
          continue;
        }

        const htmlFor = label.getAttribute('for');
        if (htmlFor) {
          const byFor = document.getElementById(htmlFor);
          if (isFieldControl(byFor)) return byFor;
        }

        const nestedControl = label.querySelector('input:not([type="hidden"]), textarea, select');
        if (isFieldControl(nestedControl)) {
          return nestedControl;
        }

        const container = label.closest('tr, li, .form-group, .field, td, div');
        if (container) {
          const nearControl = container.querySelector(
            'input:not([type="hidden"]), textarea, select',
          );
          if (isFieldControl(nearControl)) {
            return nearControl;
          }
        }
      }

      return null;
    };

    const clearedFields: string[] = [];
    const notFoundFields: string[] = [];

    for (const fieldName of names) {
      const row = findRowByFieldName(fieldName);
      if (row) {
        if (clearByRow(row)) {
          clearedFields.push(fieldName);
          continue;
        }
      }

      const control = findControlByAttributes(fieldName) ?? findControlByLabel(fieldName);
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
        clearInput(control);
      }
      clearedFields.push(fieldName);
    }

    return { clearedFields, notFoundFields };
  }, fieldNames);
}

async function clickSave(page: puppeteer.Page): Promise<void> {
  const exactSaveSelectors = [
    '#ctl00_contentSection_btnSave',
    'input[name="ctl00$contentSection$btnSave"]',
    'input[id="ctl00_contentSection_btnSave"]',
  ];

  for (const selector of exactSaveSelectors) {
    const match = await page.$(selector);
    if (!match) continue;

    await match.click();
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20_000 }).catch(() => null),
      page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => null),
    ]);
    return;
  }

  const clicked = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"]'),
    );
    const saveControl = controls.find((el) => {
      const id = (el.getAttribute('id') ?? '').toLowerCase();
      const name = (el.getAttribute('name') ?? '').toLowerCase();
      const text = ((el.textContent ?? '') || (el.getAttribute('value') ?? ''))
        .trim()
        .toLowerCase();
      return (
        id.includes('save') || name.includes('save') || text === 'save' || text.includes('save')
      );
    });

    if (!saveControl) {
      return false;
    }

    (saveControl as HTMLElement).click();
    return true;
  });

  if (!clicked) {
    throw new Error('Save button not found on process instance form.');
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20_000 }).catch(() => null),
    page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => null),
  ]);
}

async function isAuthenticatedProcessPage(page: puppeteer.Page): Promise<boolean> {
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

    await page.goto(requestedUrl, { waitUntil: 'networkidle0' });
    visitedUrl = page.url();

    if (!(await isAuthenticatedProcessPage(page))) {
      throw new Error(
        `Session is not active on the process instance page. Requested URL: ${requestedUrl}. Final URL: ${page.url()}.`,
      );
    }

    const { clearedFields, notFoundFields } = await clearFieldsByNames(page, fieldNames);
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
