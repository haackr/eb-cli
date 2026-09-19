import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

export type ImportSessionOptions = {
  env: Environment;
  profile?: string | undefined;
  chromeDataDir?: string | undefined;
  headless?: boolean | undefined;
  onAccountSelected?: ((account: Account) => void) | undefined;
};

export type ImportSessionResult = {
  cookies: puppeteer.Cookie[];
  username?: string | undefined;
  account?: string | undefined;
  isAlreadyLoggedIn: boolean;
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

export function isEBuilderAuthenticatedUrl(url: URL, env: Environment): boolean {
  const eBuilderHost = `${env}.${baseurl}`;
  if (url.hostname !== eBuilderHost) return false;

  const path = url.pathname.toLowerCase();
  if (
    path.startsWith('/auth/') ||
    path.startsWith('/login/') ||
    path.includes('loginsequence') ||
    path.includes('signin')
  ) {
    return false;
  }

  return path.startsWith('/da2/') || path.endsWith('.aspx');
}

export async function isEBuilderPageAuthenticated(
  page: puppeteer.Page,
  env: Environment,
): Promise<boolean> {
  try {
    let url: URL;
    try {
      url = new URL(page.url());
    } catch {
      return false;
    }

    const eBuilderHost = `${env}.${baseurl}`;
    if (url.hostname !== eBuilderHost) return false;

    if (isEBuilderAuthenticatedUrl(url, env)) {
      return true;
    }

    return await page.evaluate(() => {
      const authenticatedSelectors = [
        '#ctl00_ucTopNav2_tabHomeLink',
        '#ctl00_ucTopNav_tabHomeLink',
        '#ctl00_ucTopNav2_lblUserName',
        '#ctl00_ucTopNav_lblUserName',
        '#ctl00_lblUserName',
        '#ctl00_ucTopNav2_lblAccountName',
        '#ctl00_ucTopNav_lblAccountName',
        '#ctl00_lblAccount',
        'a[href*="/da2/Home/"]',
        'a[href*="/da2/Projects/"]',
        'a[href*="/Login/Logout.aspx"]',
      ];

      return authenticatedSelectors.some((sel) => document.querySelector(sel) !== null);
    });
  } catch {
    return false;
  }
}

async function waitForEBuilderHome(
  browser: puppeteer.Browser,
  env: Environment,
  onAccountSelected?: (account: Account) => void,
): Promise<puppeteer.Page> {
  const eBuilderHost = `${env}.${baseurl}`;
  const timeoutAt = Date.now() + 10 * 60_000;
  const boundPages = new WeakSet<puppeteer.Page>();
  const watchedPages = new WeakSet<puppeteer.Page>();

  while (Date.now() < timeoutAt) {
    for (const openPage of await browser.pages()) {
      let url: URL;
      try {
        url = new URL(openPage.url());
      } catch {
        continue;
      }

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

      if (
        isEBuilderAuthenticatedUrl(url, env) ||
        (await isEBuilderPageAuthenticated(openPage, env))
      ) {
        return openPage;
      }
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
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => null);
      loggedIn = await isEBuilderPageAuthenticated(page, env);
      if (loggedIn) {
        newCookies = await context.cookies();
      }
    } catch {
      loggedIn = false;
    }
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

export function getDefaultChromeDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  const googleChrome = path.join(configHome, 'google-chrome');
  if (fs.existsSync(googleChrome)) {
    return googleChrome;
  }
  return path.join(configHome, 'chromium');
}

export function copyChromeProfileForImport(
  chromeDataDir: string,
  profileName: string,
  destDir: string,
): void {
  const profileSrc = path.join(chromeDataDir, profileName);
  const profileDest = path.join(destDir, profileName);

  if (!fs.existsSync(profileSrc)) {
    throw new Error(`Chrome profile directory not found: ${profileSrc}`);
  }

  fs.mkdirSync(profileDest, { recursive: true });

  const rootFiles = [
    'Cookies',
    'Cookies-journal',
    'Preferences',
    'Secure Preferences',
    'Login Data',
    'Login Data-journal',
    'Web Data',
    'Web Data-journal',
  ];

  for (const file of rootFiles) {
    const srcFile = path.join(profileSrc, file);
    if (fs.existsSync(srcFile)) {
      try {
        fs.copyFileSync(srcFile, path.join(profileDest, file));
      } catch {}
    }
  }

  const dirsToCopy = [
    'Network',
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'Extensions',
    'Extension State',
    'Extension Rules',
    'Local Extension Settings',
    'Sync Extension Settings',
  ];
  for (const dir of dirsToCopy) {
    const srcSubDir = path.join(profileSrc, dir);
    if (fs.existsSync(srcSubDir)) {
      const destSubDir = path.join(profileDest, dir);
      try {
        fs.cpSync(srcSubDir, destSubDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const localStateSrc = path.join(chromeDataDir, 'Local State');
  if (fs.existsSync(localStateSrc)) {
    try {
      fs.copyFileSync(localStateSrc, path.join(destDir, 'Local State'));
    } catch {}
  }
}

export async function extractUserInfoFromPage(
  page: puppeteer.Page,
): Promise<{ username?: string | undefined; account?: string | undefined }> {
  try {
    return await page.evaluate(() => {
      let username: string | undefined;
      let account: string | undefined;

      const userSelectors = [
        '#ctl00_ucTopNav2_lblUserName',
        '#ctl00_ucTopNav_lblUserName',
        '#ctl00_lblUserName',
        '#ctl00_ucTopNav2_hypUser',
        '#ctl00_ucTopNav_hypUser',
        '#ctl00_ucTopNav2_lnkUser',
        '#ctl00_ucTopNav_lnkUser',
        '.user-name',
        '.username',
      ];
      for (const sel of userSelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text) {
          username = text;
          break;
        }
      }

      const accountSelectors = [
        '#ctl00_ucTopNav2_lblAccountName',
        '#ctl00_ucTopNav_lblAccountName',
        '#ctl00_lblAccountName',
        '#ctl00_lblAccount',
        '#ctl00_ucTopNav2_lblAccount',
        '#ctl00_ucTopNav_lblAccount',
        '.account-name',
      ];
      for (const sel of accountSelectors) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text) {
          account = text;
          break;
        }
      }

      if (!account) {
        const accountSelect = document.querySelector(
          '#ctl00_ucTopNav2_ddlAccounts, #ctl00_ucTopNav_ddlAccounts, select[name*="ddlAccounts"]',
        ) as HTMLSelectElement | null;
        if (accountSelect && accountSelect.selectedOptions?.length > 0) {
          const selectedText = accountSelect.selectedOptions[0]?.textContent?.trim();
          if (selectedText) {
            account = selectedText;
          }
        }
      }

      return { username, account };
    });
  } catch {
    return {};
  }
}

export async function importSessionFromChrome(
  options: ImportSessionOptions,
): Promise<ImportSessionResult> {
  const {
    env,
    profile = 'Default',
    chromeDataDir = getDefaultChromeDataDir(),
    headless = false,
    onAccountSelected,
  } = options;

  if (!fs.existsSync(chromeDataDir)) {
    throw new Error(`Google Chrome user data directory not found at: ${chromeDataDir}`);
  }

  const profileDir = path.join(chromeDataDir, profile);
  if (!fs.existsSync(profileDir)) {
    const availableProfiles = fs
      .readdirSync(chromeDataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile ')))
      .map((d) => d.name);
    throw new Error(
      `Chrome profile '${profile}' not found at: ${profileDir}.${
        availableProfiles.length > 0 ? ` Available profiles: ${availableProfiles.join(', ')}` : ''
      }`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-chrome-import-'));

  let browser: puppeteer.Browser | undefined;
  try {
    copyChromeProfileForImport(chromeDataDir, profile, tmpDir);

    const launchArgs = [
      `--user-data-dir=${tmpDir}`,
      `--profile-directory=${profile}`,
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1200,800',
    ];

    browser = await puppeteer.launch({
      headless,
      channel: 'chrome',
      ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
      args: launchArgs,
    });

    const [page] = await browser.pages();
    if (!page) throw new Error('No browser page found.');

    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(90_000);

    const targetUrl = `https://${env}.${baseurl}/da2/Home/index2.aspx`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    let authenticatedPage: puppeteer.Page | undefined;
    const isAlreadyLoggedIn = await isEBuilderPageAuthenticated(page, env);

    if (isAlreadyLoggedIn) {
      authenticatedPage = page;
    } else {
      if (headless) {
        throw new Error(
          `No active e-Builder session found in Chrome profile '${profile}' for environment '${env}'. Run without --no-show_browser to log in interactively.`,
        );
      }

      authenticatedPage = await waitForEBuilderHome(browser, env, onAccountSelected);
    }

    const userInfo = await extractUserInfoFromPage(authenticatedPage || page);
    const cookies = await browser.cookies();

    return {
      cookies,
      username: userInfo.username,
      account: userInfo.account,
      isAlreadyLoggedIn,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  }
}
