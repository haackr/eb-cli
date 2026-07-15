import puppeteer from 'puppeteer';
import { Environment, baseurl, BrowserManager } from './index.js';

export type UserToDelete = {
  userName?: string;
};

type DeleteUserArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  user: UserToDelete;
  dryRun: boolean;
};

type SetUserSsoArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  userId: string;
  enabled: boolean;
  dryRun?: boolean;
};

export type UserFieldValueMap = Record<string, string>;

type SetUserFieldsArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  userId: string;
  fieldValues: UserFieldValueMap;
  dryRun?: boolean;
};

export type SetUserSsoResult = {
  userId: string;
  visitedUrl: string;
};

export type SetUserFieldsResult = {
  userId: string;
  visitedUrl: string;
  updatedFields: string[];
  notFoundFields: string[];
};

export type ManagedUserRow = {
  userId: string;
  name: string;
  userName: string;
  companyName: string;
  viewUrl: string;
};

export type UserSsoStatus = {
  userId: string;
  visitedUrl: string;
  loginAuthentication: string;
  ssoRequired: boolean;
};

const userNameInput = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_txtUserName';
const filterButton = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnFilter';
const selectFirstCheckbox = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults_ctl03_cbox';
const deleteButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnRemove';
const confirmButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYes';
const cancelButton = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnNo';

const userSaveSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnSave1';

async function clickUserSave(page: puppeteer.Page): Promise<void> {
  const match = await page.$(userSaveSelector);
  if (!match) {
    throw new Error(`Save button not found on user edit page: ${userSaveSelector}`);
  }

  await match.click();

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20_000 }).catch(() => null),
    page.waitForNetworkIdle({ idleTime: 1_000, timeout: 20_000 }).catch(() => null),
  ]);
}

async function setSsoField(page: puppeteer.Page, enabled: boolean): Promise<void> {
  const setResult = await page.evaluate((value) => {
    const trigger = (el: HTMLElement): void => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const row = document.getElementById(
      'ctl00_ctl00_ContentPlaceHolder1_contentSection_trLoginAndContact',
    );
    const scope = row ?? document;

    const requireSso = scope.querySelector(
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
    ) as HTMLInputElement | null;
    const requireNone = scope.querySelector(
      '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
    ) as HTMLInputElement | null;

    const target = value ? requireSso : requireNone;
    if (!target) {
      return { found: false };
    }

    target.checked = true;
    trigger(target);
    return { found: true };
  }, enabled);

  if (!setResult.found) {
    throw new Error('SSO field not found on user edit page.');
  }
}

async function setUserFieldsOnPage(
  page: puppeteer.Page,
  fieldValues: UserFieldValueMap,
): Promise<{ updatedFields: string[]; notFoundFields: string[] }> {
  return page.evaluate((entries) => {
    type BuiltInFieldConfig =
      | { kind: 'text'; selector: string }
      | { kind: 'checkbox'; selector: string }
      | { kind: 'select'; selector: string }
      | { kind: 'radio'; options: Record<string, string> };

    const builtInFields: Record<string, BuiltInFieldConfig> = {
      'first name': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptFirstName',
      },
      company: {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptCompany',
      },
      'last name': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptLastName',
      },
      'access expires': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_rdpExpirationDate_dateInput',
      },
      'hide in global directory': {
        kind: 'checkbox',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_chkHideFromGlobal',
      },
      'login authentication': {
        kind: 'radio',
        options: {
          'require single sign on': '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          'require single sign-on': '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          requiresso: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          sso: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          true: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          yes: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          '1': '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireSSO',
          none: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
          false: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
          no: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
          '0': '#ctl00_ctl00_ContentPlaceHolder1_contentSection_requireNone',
        },
      },
      'type of business': {
        kind: 'select',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_dlTypeOfBiz',
      },
      title: {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptJobTitle',
      },
      department: {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptdept',
      },
      'business address': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficeAddress',
      },
      'po box suite': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficePOBox',
      },
      city: {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficeCity',
      },
      'state province': {
        kind: 'select',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_dlOfficeStates',
      },
      country: {
        kind: 'select',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_ddlOfficeCountry',
      },
      'postal zip code': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficeZip',
      },
      'office phone': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficePhone',
      },
      'office fax': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficeFax',
      },
      'business cell phone': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficeCell',
      },
      'business pager': {
        kind: 'text',
        selector: '#ctl00_ctl00_ContentPlaceHolder1_contentSection_iptOfficePager',
      },
    };

    const updatedFields: string[] = [];
    const notFoundFields: string[] = [];

    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[†*:]/g, ' ')
        .replace(/[()]/g, ' ')
        .replace(/[./\\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const trigger = (el: HTMLElement): void => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const setTextValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      element.focus();
      element.value = value;
      trigger(element);
    };

    const setCheckboxValue = (element: HTMLInputElement, rawValue: string): boolean => {
      const normalized = normalize(rawValue);
      if (['true', 'yes', 'y', '1', 'on', 'checked'].includes(normalized)) {
        element.checked = true;
      } else if (['false', 'no', 'n', '0', 'off', 'unchecked'].includes(normalized)) {
        element.checked = false;
      } else {
        return false;
      }

      trigger(element);
      return true;
    };

    const setSelectValue = (element: HTMLSelectElement, rawValue: string): boolean => {
      const normalizedValue = normalize(rawValue);
      const match = Array.from(element.options).find((option) => {
        return (
          normalize(option.value) === normalizedValue || normalize(option.text) === normalizedValue
        );
      });

      if (!match) {
        return false;
      }

      element.value = match.value;
      trigger(element);
      return true;
    };

    const setRadioValue = (selectors: Record<string, string>, rawValue: string): boolean => {
      const selector = selectors[normalize(rawValue)];
      if (!selector) {
        return false;
      }

      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) {
        return false;
      }

      input.checked = true;
      trigger(input);
      return true;
    };

    const findCustomFieldControl = (fieldName: string): HTMLElement | null => {
      const container = document.querySelector(
        '#ctl00_ctl00_ContentPlaceHolder1_contentSection_pvCustomFields',
      );
      if (!container) {
        return null;
      }

      const rows = Array.from(container.querySelectorAll('tr'));
      for (const row of rows) {
        const labelCell = row.querySelector('td.Label') as HTMLTableCellElement | null;
        if (!labelCell || normalize(labelCell.textContent ?? '') !== normalize(fieldName)) {
          continue;
        }

        const detailsCell = row.querySelector('td.Details') as HTMLTableCellElement | null;
        if (!detailsCell) {
          return null;
        }

        return detailsCell.querySelector('select, textarea, input:not([type="hidden"])');
      }

      return null;
    };

    const setCustomFieldValue = (fieldName: string, rawValue: string): boolean => {
      const control = findCustomFieldControl(fieldName);
      if (!control) {
        return false;
      }

      if (control instanceof HTMLSelectElement) {
        return setSelectValue(control, rawValue);
      }

      if (control instanceof HTMLTextAreaElement) {
        setTextValue(control, rawValue);
        return true;
      }

      if (control instanceof HTMLInputElement) {
        if (control.type === 'checkbox') {
          return setCheckboxValue(control, rawValue);
        }

        if (control.type === 'radio') {
          const sameNameInputs = Array.from(
            control
              .closest('td.Details')
              ?.querySelectorAll(`input[type="radio"][name="${control.name}"]`) ?? [],
          ) as HTMLInputElement[];
          const normalized = normalize(rawValue);
          const match = sameNameInputs.find((input) => {
            const label = input.id
              ? (document.querySelector(`label[for="${input.id}"]`) as HTMLElement | null)
              : null;
            return (
              normalize(input.value) === normalized ||
              normalize(label?.textContent ?? '') === normalized
            );
          });

          if (!match) {
            return false;
          }

          match.checked = true;
          trigger(match);
          return true;
        }

        setTextValue(control, rawValue);
        return true;
      }

      return false;
    };

    for (const [fieldName, rawValue] of Object.entries(entries)) {
      const normalizedFieldName = normalize(fieldName);
      const builtIn = builtInFields[normalizedFieldName];
      let updated = false;

      if (builtIn) {
        if (builtIn.kind === 'text') {
          const element = document.querySelector(builtIn.selector) as
            | HTMLInputElement
            | HTMLTextAreaElement
            | null;
          if (element) {
            setTextValue(element, rawValue);
            updated = true;
          }
        }

        if (builtIn.kind === 'checkbox') {
          const element = document.querySelector(builtIn.selector) as HTMLInputElement | null;
          if (element) {
            updated = setCheckboxValue(element, rawValue);
          }
        }

        if (builtIn.kind === 'select') {
          const element = document.querySelector(builtIn.selector) as HTMLSelectElement | null;
          if (element) {
            updated = setSelectValue(element, rawValue);
          }
        }

        if (builtIn.kind === 'radio') {
          updated = setRadioValue(builtIn.options, rawValue);
        }
      } else {
        updated = setCustomFieldValue(fieldName, rawValue);
      }

      if (updated) {
        updatedFields.push(fieldName);
      } else {
        notFoundFields.push(fieldName);
      }
    }

    return { updatedFields, notFoundFields };
  }, fieldValues);
}

export async function deleteUser(options: DeleteUserArgs): Promise<void> {
  const { env, cookies, browser, user, dryRun = false } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  if (!user.userName) {
    throw new Error(
      'Missing userName. CSV must include userName for each row until lookup by email/userName is implemented.',
    );
  }

  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const url = `https://${env}.${baseurl}/da2/Setup/Admin/Users/ManageUsers.aspx`;

    await page.goto(url, { waitUntil: 'networkidle0' });

    await page.locator(userNameInput).fill(user.userName);
    await page.locator(filterButton).click();
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    await page.locator(selectFirstCheckbox).click();

    await page.locator(deleteButtonSelector).click();

    if (!dryRun) {
      await page.locator(confirmButtonSelector).click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    } else {
      await page.locator(cancelButton).click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}

export async function setUserSso(options: SetUserSsoArgs): Promise<SetUserSsoResult> {
  const { env, cookies, browser, userId, enabled, dryRun = false } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  if (!userId.trim()) {
    throw new Error('Missing userId. CSV must include userId for each row.');
  }

  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const userIdEncoded = encodeURIComponent(userId.trim());
    const url = `https://${env}.${baseurl}/da2/Setup/Admin/Users/AddEditUser.aspx?Mode=Edit&UserID=${userIdEncoded}`;
    await page.goto(url, { waitUntil: 'networkidle0' });

    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('/login') || currentUrl.includes('signin')) {
      throw new Error(
        `Session is not active on the user edit page. Requested URL: ${url}. Final URL: ${page.url()}.`,
      );
    }

    await setSsoField(page, enabled);

    if (!dryRun) {
      await clickUserSave(page);
    }

    return {
      userId: userId.trim(),
      visitedUrl: page.url(),
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}

export async function setUserFields(options: SetUserFieldsArgs): Promise<SetUserFieldsResult> {
  const { env, cookies, browser, userId, fieldValues, dryRun = false } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());

  if (!userId.trim()) {
    throw new Error('Missing userId. CSV must include userId for each row.');
  }

  if (Object.keys(fieldValues).length === 0) {
    throw new Error('No field values provided for user update.');
  }

  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const userIdEncoded = encodeURIComponent(userId.trim());
    const url = `https://${env}.${baseurl}/da2/Setup/Admin/Users/AddEditUser.aspx?Mode=Edit&UserID=${userIdEncoded}`;
    await page.goto(url, { waitUntil: 'networkidle0' });

    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('/login') || currentUrl.includes('signin')) {
      throw new Error(
        `Session is not active on the user edit page. Requested URL: ${url}. Final URL: ${page.url()}.`,
      );
    }

    const updateResult = await setUserFieldsOnPage(page, fieldValues);

    if (!dryRun && updateResult.updatedFields.length > 0) {
      await clickUserSave(page);
    }

    return {
      userId: userId.trim(),
      visitedUrl: page.url(),
      updatedFields: updateResult.updatedFields,
      notFoundFields: updateResult.notFoundFields,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}

type ListManagedUsersArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
};

type GetUserSsoStatusArgs = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser;
  userId: string;
  viewUrl?: string;
};

export async function listManagedUsers(options: ListManagedUsersArgs): Promise<ManagedUserRow[]> {
  const { env, cookies, browser } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());
  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const manageUrl = `https://${env}.${baseurl}/da2/Setup/Admin/Users/ManageUsers.aspx`;
    await page.goto(manageUrl, { waitUntil: 'networkidle0' });

    const rowsById = new Map<string, ManagedUserRow>();

    for (;;) {
      await page.waitForSelector('#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults', {
        timeout: 20_000,
      });

      const pageRows = await page.evaluate(() => {
        const table = document.querySelector(
          '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults',
        ) as HTMLTableElement | null;
        if (!table) {
          return [] as ManagedUserRow[];
        }

        const result: ManagedUserRow[] = [];
        const rows = Array.from(table.querySelectorAll('tr.RowData, tr.AltRowData'));
        for (const row of rows) {
          const checkbox = row.querySelector(
            'input[type="checkbox"][data-userid]',
          ) as HTMLInputElement | null;
          const userId = checkbox?.getAttribute('data-userid')?.trim() ?? '';
          if (!userId) continue;

          const nameAnchor = row.querySelector('a[id$="_UserName"]') as HTMLAnchorElement | null;
          const name = nameAnchor?.textContent?.trim() ?? checkbox?.getAttribute('data-name') ?? '';
          const viewUrl = nameAnchor?.getAttribute('href')?.trim() ?? '';

          const cells = Array.from(row.querySelectorAll('td'));
          const userName = cells[3]?.textContent?.trim() ?? '';
          const companyName = cells[4]?.textContent?.trim() ?? '';

          result.push({ userId, name, userName, companyName, viewUrl });
        }

        return result;
      });

      for (const row of pageRows) {
        if (!rowsById.has(row.userId)) {
          rowsById.set(row.userId, row);
        }
      }

      const hasNextLink = await page.evaluate(() => {
        const pagingRow = document.querySelector('tr.Paging');
        if (!pagingRow) return false;

        const nextLink = Array.from(pagingRow.querySelectorAll('a')).find((a) =>
          (a.textContent ?? '').toLowerCase().includes('next'),
        );
        return Boolean(nextLink);
      });

      if (!hasNextLink) {
        break;
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }),
        page.evaluate(() => {
          const pagingRow = document.querySelector('tr.Paging');
          if (!pagingRow) return;

          const nextLink = Array.from(pagingRow.querySelectorAll('a')).find((a) =>
            (a.textContent ?? '').toLowerCase().includes('next'),
          ) as HTMLAnchorElement | undefined;

          nextLink?.click();
        }),
      ]);
    }

    return Array.from(rowsById.values());
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}

export async function getUserSsoStatus(options: GetUserSsoStatusArgs): Promise<UserSsoStatus> {
  const { env, cookies, browser, userId, viewUrl } = options;
  const browserInstance = browser || (await BrowserManager.getInstance().getBrowser());
  let page: puppeteer.Page | null = null;

  try {
    if (!browserInstance.connected) {
      throw new Error('Browser is not connected');
    }

    const context = browserInstance.defaultBrowserContext();
    await context.setCookie(...cookies);

    page = await context.newPage();
    await context.setCookie(...cookies);

    const defaultViewUrl = `https://${env}.${baseurl}/da2/Setup/Admin/Users/ViewUser.aspx?UserID=${encodeURIComponent(
      userId,
    )}`;
    const resolvedViewUrl = viewUrl
      ? new URL(viewUrl, `https://${env}.${baseurl}`).toString()
      : defaultViewUrl;

    await page.goto(resolvedViewUrl, { waitUntil: 'networkidle0' });

    const currentUrl = page.url().toLowerCase();
    if (currentUrl.includes('/login') || currentUrl.includes('signin')) {
      throw new Error(
        `Session is not active on the user view page. Requested URL: ${resolvedViewUrl}. Final URL: ${page.url()}.`,
      );
    }

    const loginAuthentication = await page.evaluate(() => {
      const label = document.querySelector(
        '#ctl00_ctl00_ContentPlaceHolder1_contentSection_lblLogin',
      ) as HTMLElement | null;
      if (label) {
        return label.textContent?.trim() ?? '';
      }

      const row = document.querySelector(
        '#ctl00_ctl00_ContentPlaceHolder1_contentSection_trLoginAndResourceInfo',
      );
      const details = row?.querySelector(
        '#ctl00_ctl00_ContentPlaceHolder1_contentSection_tdLoginAuthenticationDetails',
      ) as HTMLElement | null;
      return details?.textContent?.trim() ?? '';
    });

    if (!loginAuthentication) {
      throw new Error('Login Authentication field not found on user view page.');
    }

    return {
      userId,
      visitedUrl: page.url(),
      loginAuthentication,
      ssoRequired: /require\s+single\s+sign-?on/i.test(loginAuthentication),
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors for command resiliency.
      }
    }
  }
}
