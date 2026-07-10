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

export type SetUserSsoResult = {
  userId: string;
  visitedUrl: string;
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
