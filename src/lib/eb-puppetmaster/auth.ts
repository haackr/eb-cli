import puppeteer from 'puppeteer';
import { Environment, baseurl, BrowserManager } from './index.js';

// Selectors for the login page
const usernameSelector = '#txtUsername >>> #mwc_id_0_text_input';
const usernameContinueButtonSelector = '#usernameContinueBtn >>> button';
const passwordSelector = '#txtPassword >>> #mwc_id_1_text_input';
const signInButtonSelector = '#signIn >>> button';
const selectAccountSelector = '#selectAccount >>> select';
const selectAccountContinueButtonSelector = '#selectAccountContinueBtn >>> button';
const myHomeTabSelector = '#ctl00_ucTopNav2_tabHomeLink';
const errorMessageSelector = '#errorMessage';
const changePasswordUrl = '/auth/Authenticate/LoginSequence.aspx';
const trimbleUsernameSelector = '#username-field';
const trimbleUsernameContinueButtonSelector = '#enter_username_submit';
const trimblePasswordSelector =
  'input[tcp-auto="input-password"][type="password"][name="password"]';
const trimbleSignInButtonSelector = 'button:has(span[data-i18n="button_sign_in"])';

export type Account = {
  value: string;
  text: string;
};

async function getAccounts(accountOptions: puppeteer.ElementHandle[]): Promise<Account[]> {
  let accounts: Account[] = [];
  for (let i = 1; i < accountOptions.length; i++) {
    const optionValue = await accountOptions[i]?.evaluate((el) => (el as HTMLOptionElement).value);
    const optionText = await accountOptions[i]?.evaluate((el) => el.textContent ?? '');
    accounts.push({ value: String(optionValue), text: String(optionText) });
  }
  return accounts;
}

async function selectAccount(
  accountSelector: puppeteer.ElementHandle,
  account: string,
  accountOptions: Account[],
): Promise<void> {
  for (const option of accountOptions) {
    if (option.text.includes(account)) {
      console.log('Found account');
      await accountSelector?.select(option.value);
      break;
    }
  }
}

function isTrimbleIdPage(page: puppeteer.Page): boolean {
  return new URL(page.url()).hostname === 'id.trimble.com';
}

async function getTrimbleIdPage(browser: puppeteer.Browser): Promise<puppeteer.Page | undefined> {
  return (await browser.pages()).find((openPage) => isTrimbleIdPage(openPage));
}

async function waitForTrimbleIdPage(
  browser: puppeteer.Browser,
  timeout: number = 10_000,
): Promise<puppeteer.Page | undefined> {
  const timeoutAt = Date.now() + timeout;

  while (Date.now() < timeoutAt) {
    const trimbleIdPage = await getTrimbleIdPage(browser);
    if (trimbleIdPage) return trimbleIdPage;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return undefined;
}

async function getSelectedAccount(page: puppeteer.Page): Promise<Account | undefined> {
  const accountSelector = await page.$(selectAccountSelector);
  if (!accountSelector) return;

  const selectedValue = await accountSelector.evaluate((element) => {
    return (element as HTMLSelectElement).value;
  });
  if (!selectedValue) return;

  const accounts = await getAccounts(await page.$$(selectAccountSelector + ' option'));
  return accounts.find((account) => account.value === selectedValue);
}

const accountSelectionBindingName = '__ebCliAccountSelected';

async function watchAccountSelection(
  page: puppeteer.Page,
  boundPages: WeakSet<puppeteer.Page>,
  watchedPages: WeakSet<puppeteer.Page>,
  onAccountSelected: (account: Account) => void,
): Promise<void> {
  if (!boundPages.has(page)) {
    await page.exposeFunction(accountSelectionBindingName, (value: string, text: string) => {
      onAccountSelected({ value, text });
    });
    boundPages.add(page);
  }

  if (watchedPages.has(page)) return;

  const accountSelector = await page.$(selectAccountSelector);
  if (!accountSelector) return;

  await accountSelector.evaluate((element, bindingName) => {
    const select = element as HTMLSelectElement;
    select.addEventListener('change', () => {
      const selectedOption = select.selectedOptions.item(0);
      if (!selectedOption?.value) return;

      const binding = (window as unknown as Record<string, (value: string, text: string) => void>)[
        bindingName
      ];
      binding?.(selectedOption.value, selectedOption.text);
    });
  }, accountSelectionBindingName);
  watchedPages.add(page);
}

function isNavigationRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Argument should belong to the same JavaScript world/.test(
      error.message,
    )
  );
}

async function waitForEBuilderHome(
  browser: puppeteer.Browser,
  env: Environment,
  onAccountSelected?: (account: Account) => void,
): Promise<void> {
  const eBuilderHost = `${env}.${baseurl}`;
  const timeoutAt = Date.now() + 10 * 60_000;
  const boundPages = new WeakSet<puppeteer.Page>();
  const watchedPages = new WeakSet<puppeteer.Page>();

  while (Date.now() < timeoutAt) {
    for (const openPage of await browser.pages()) {
      const url = new URL(openPage.url());
      if (url.hostname !== eBuilderHost) continue;

      let account: Account | undefined;
      try {
        if (onAccountSelected) {
          await watchAccountSelection(openPage, boundPages, watchedPages, onAccountSelected);
        }
        account = await getSelectedAccount(openPage);
      } catch (error) {
        if (isNavigationRace(error)) continue;
        throw error;
      }
      if (account) onAccountSelected?.(account);

      if (url.pathname.startsWith('/da2/Home/')) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for authentication to redirect to e-Builder.');
}

async function completeTrimbleIdLogin(
  browser: puppeteer.Browser,
  page: puppeteer.Page,
  env: Environment,
  headless: boolean,
  username?: string,
  password?: string,
  onAccountSelected?: (account: Account) => void,
): Promise<puppeteer.Cookie[]> {
  let authBrowser = browser;
  let authPage = page;

  if (headless) {
    const trimbleUrl = page.url();
    const cookies = await browser.cookies();

    await BrowserManager.getInstance().closeBrowser();
    authBrowser = await BrowserManager.getInstance().getBrowser(false, ['--window-size=1200,800']);
    await authBrowser.defaultBrowserContext().setCookie(...cookies);

    const [visiblePage] = await authBrowser.pages();
    if (!visiblePage) throw new Error('No page found');
    authPage = visiblePage;
    await authPage.goto(trimbleUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }

  if (username) {
    await authPage.locator(trimbleUsernameSelector).fill(username);
    await authPage.locator(trimbleUsernameContinueButtonSelector).click();
  }
  if (password) {
    await authPage.waitForFunction(
      (selector) => {
        const input = document.querySelector<HTMLInputElement>(selector);
        return Boolean(input && !input.disabled && input.getClientRects().length > 0);
      },
      {},
      trimblePasswordSelector,
    );
    await authPage.locator(trimblePasswordSelector).fill(password);
    await authPage.locator(trimbleSignInButtonSelector).click();
  }

  await waitForEBuilderHome(authBrowser, env, onAccountSelected);
  return await authBrowser.cookies();
}

export async function login(
  env: Environment,
  headless: boolean = false,
  username?: string,
  password?: string,
  account?: string,
  accountSpecifier?: Function,
  browser?: puppeteer.Browser,
  onAccountSelected?: (account: Account) => void,
): Promise<puppeteer.Cookie[]> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
      `--window-size=800,600`,
    ]);
  }
  const [page] = await browser.pages();

  if (!page) throw new Error('No page found');
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  const loginUrl = `https://${env}.${baseurl}/auth/www/index.aspx?ReturnUrl=%2f`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  if (username) {
    await page.locator(usernameSelector).fill(username);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }),
      page.locator(usernameContinueButtonSelector).click(),
    ]);

    const trimbleIdPage = await waitForTrimbleIdPage(browser);
    if (trimbleIdPage) {
      return await completeTrimbleIdLogin(
        browser,
        trimbleIdPage,
        env,
        headless,
        username,
        password,
        onAccountSelected,
      );
    }

    if (!password) {
      if (headless) {
        throw new Error('Password must be provided for headless mode.');
      }

      await waitForEBuilderHome(browser, env);
      return await browser.cookies();
    }

    await page.locator(passwordSelector).fill(password);
    await page.locator(signInButtonSelector).click();
    await page.waitForNetworkIdle();
    const errorMessageBox = await page.$(errorMessageSelector);
    if (errorMessageBox && (await errorMessageBox.isVisible()))
      throw new Error(
        'Invalid username / password or account is locked or user already has maximum sessions open',
      );
    // await page.waitForNavigation();

    if (account) {
      console.log(account);
      const accountSelector = await page.waitForSelector(selectAccountSelector);
      if (!accountSelector) throw new Error('Account selector not found');
      const accountOptions = await page.$$(selectAccountSelector + ' option');
      const accounts = await getAccounts(accountOptions);
      await selectAccount(accountSelector, account, accounts);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }),
        page.locator(selectAccountContinueButtonSelector).click(),
      ]);
    } else {
      const accountSelector = await page.$(selectAccountSelector);
      if (accountSelector) {
        const accountOpttions = await page.$$(selectAccountSelector + ' option');
        const accounts = await getAccounts(accountOpttions);
        if (!accountSpecifier) throw new Error('Account specifier must be provided');
        const selectedAccount = await accountSpecifier(accounts);
        await accountSelector?.select(selectedAccount);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }),
          page.locator(selectAccountContinueButtonSelector).click(),
        ]);
      }
    }
  } else if (headless) {
    throw new Error('Username and password must be provided for headless mode');
  } else {
    await page.waitForSelector(usernameSelector);
    await page.waitForNavigation();
    const trimbleIdPage = await waitForTrimbleIdPage(browser);
    if (trimbleIdPage) {
      return await completeTrimbleIdLogin(
        browser,
        trimbleIdPage,
        env,
        headless,
        undefined,
        undefined,
        onAccountSelected,
      );
    }
    await page.waitForSelector(passwordSelector);
    await page.waitForNavigation();
    if (await page.$(selectAccountSelector)) {
      await page.waitForNavigation();
    }
  }

  if (page.url().includes(changePasswordUrl)) {
    throw new Error('Password change required. Please login manually and change your password.');
  }

  const cookies = await browser.cookies();
  return cookies;
}

export async function loginWithSso(
  env: Environment,
  ssoUrl: string,
  browser?: puppeteer.Browser,
): Promise<puppeteer.Cookie[]> {
  let url: URL;
  try {
    url = new URL(ssoUrl);
  } catch {
    throw new Error('SSO URL must be an absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('SSO URL must use HTTP or HTTPS.');
  }

  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(
      false,
      ['--window-size=1200,800'],
      true,
    );
  }

  const [page] = await browser.pages();
  if (!page) throw new Error('No page found');
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  await waitForEBuilderHome(browser, env);
  return await browser.cookies();
}

export async function isLoggedIn(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser,
): Promise<{ isLoggedIn: boolean; newCookies: puppeteer.Cookie[] }> {
  let loggedIn = false;
  let newCookies: puppeteer.Cookie[] = [];
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }

  // Create a new browser context for isolation
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  // Clear existing cookies and set new ones
  await context.setCookie(...cookies);
  await page.goto(`https://${env}.${baseurl}/da2/Home/index2.aspx`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  try {
    await page.waitForSelector(myHomeTabSelector, {
      timeout: 5000,
    });
    loggedIn = true;
    newCookies = await context.cookies();
  } catch {
    loggedIn = false;
  }

  // Close the context to clean up
  await context.close();

  return { isLoggedIn: loggedIn, newCookies: newCookies };
}

export async function logout(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser,
): Promise<void> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }

  // Create a new browser context for isolation
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  await context.setCookie(...cookies);
  await page.goto(`https://${env}.${baseurl}/Login/Logout.aspx`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  // Close the context to clean up
  await context.close();
}
