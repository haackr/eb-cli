import { type Browser, type Page } from 'playwright';
import { Environment, baseurl, BrowserManager, normalizeCookies, type Cookie } from './index.js';

// Selectors for the login page
const usernameSelector = '#txtUsername input';
const usernameContinueButtonSelector = '#usernameContinueBtn button';
const passwordSelector = '#txtPassword input';
const signInButtonSelector = '#signIn button';
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

function getAllPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

function isTrimbleIdPage(page: Page): boolean {
  try {
    return new URL(page.url()).hostname === 'id.trimble.com';
  } catch {
    return false;
  }
}

async function getTrimbleIdPage(browser: Browser): Promise<Page | undefined> {
  return getAllPages(browser).find((openPage) => isTrimbleIdPage(openPage));
}

async function waitForTrimbleIdPage(
  browser: Browser,
  timeout: number = 10_000,
): Promise<Page | undefined> {
  const timeoutAt = Date.now() + timeout;

  while (Date.now() < timeoutAt) {
    const trimbleIdPage = await getTrimbleIdPage(browser);
    if (trimbleIdPage) return trimbleIdPage;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return undefined;
}

async function getSelectedAccount(page: Page): Promise<Account | undefined> {
  return await page
    .evaluate(() => {
      const mwcSelect = document.querySelector('#selectAccount') as any;
      if (!mwcSelect) return undefined;
      const nativeSelect =
        mwcSelect.shadowRoot?.querySelector('select') || mwcSelect.querySelector('select');
      const selectedValue = mwcSelect.value || nativeSelect?.value;
      if (!selectedValue) return undefined;

      const optionElements: any[] = nativeSelect
        ? Array.from(nativeSelect.querySelectorAll('option'))
        : Array.from(mwcSelect.querySelectorAll('mwc-list-item, option'));

      const found = optionElements.find(
        (opt) => (opt.value || opt.getAttribute?.('value')) === selectedValue,
      );
      if (!found) return undefined;
      return {
        value: selectedValue,
        text: (found.textContent || '').trim(),
      };
    })
    .catch(() => undefined);
}

const accountSelectionBindingName = '__ebCliAccountSelected';

async function watchAccountSelection(
  page: Page,
  boundPages: WeakSet<Page>,
  watchedPages: WeakSet<Page>,
  onAccountSelected: (account: Account) => void,
): Promise<void> {
  if (!boundPages.has(page)) {
    await page.exposeFunction(accountSelectionBindingName, (value: string, text: string) => {
      onAccountSelected({ value, text });
    });
    boundPages.add(page);
  }

  if (watchedPages.has(page)) return;

  await page
    .evaluate((bindingName) => {
      const mwcSelect = document.querySelector('#selectAccount') as any;
      if (!mwcSelect) return;

      const notify = () => {
        const nativeSelect =
          mwcSelect.shadowRoot?.querySelector('select') || mwcSelect.querySelector('select');
        const val = mwcSelect.value || nativeSelect?.value;
        const selectedOption = nativeSelect?.selectedOptions?.item(0);
        const text = selectedOption?.text || mwcSelect.selectedText || val;
        if (!val) return;

        const binding = (
          window as unknown as Record<string, (value: string, text: string) => void>
        )[bindingName];
        binding?.(val, text);
      };

      mwcSelect.addEventListener('change', notify);
      mwcSelect.addEventListener('selected', notify);
      const nativeSelect =
        mwcSelect.shadowRoot?.querySelector('select') || mwcSelect.querySelector('select');
      nativeSelect?.addEventListener('change', notify);
    }, accountSelectionBindingName)
    .catch(() => {});

  watchedPages.add(page);
}

function isNavigationRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Argument should belong to the same JavaScript world|Target closed|frame was detached/.test(
      error.message,
    )
  );
}

async function waitForEBuilderHome(
  browser: Browser,
  env: Environment,
  onAccountSelected?: (account: Account) => void,
): Promise<void> {
  const eBuilderHost = `${env}.${baseurl}`;
  const timeoutAt = Date.now() + 10 * 60_000;
  const boundPages = new WeakSet<Page>();
  const watchedPages = new WeakSet<Page>();

  while (Date.now() < timeoutAt) {
    for (const openPage of getAllPages(browser)) {
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

      if (url.pathname.startsWith('/da2/Home/')) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for authentication to redirect to e-Builder.');
}

async function completeTrimbleIdLogin(
  browser: Browser,
  page: Page,
  env: Environment,
  headless: boolean,
  username?: string,
  password?: string,
  onAccountSelected?: (account: Account) => void,
): Promise<Cookie[]> {
  let authBrowser = browser;
  let authPage = page;

  if (headless) {
    const trimbleUrl = page.url();
    const context = page.context();
    const cookies = await context.cookies();

    await BrowserManager.getInstance().closeBrowser();
    authBrowser = await BrowserManager.getInstance().getBrowser(false, ['--window-size=1200,800']);
    const newContext = await authBrowser.newContext();
    await newContext.addCookies(normalizeCookies(cookies));

    authPage = await newContext.newPage();
    await authPage.goto(trimbleUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }

  if (username) {
    await authPage.locator(trimbleUsernameSelector).fill(username);
    await authPage.locator(trimbleUsernameContinueButtonSelector).click();
  }
  if (password) {
    await authPage.waitForFunction((selector) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      return Boolean(input && !input.disabled && input.getClientRects().length > 0);
    }, trimblePasswordSelector);
    await authPage.locator(trimblePasswordSelector).fill(password);
    await authPage.locator(trimbleSignInButtonSelector).click();
  }

  await waitForEBuilderHome(authBrowser, env, onAccountSelected);
  return await authPage.context().cookies();
}

export async function login(
  env: Environment,
  headless: boolean = false,
  username?: string,
  password?: string,
  account?: string,
  accountSpecifier?: Function,
  browser?: Browser,
  onAccountSelected?: (account: Account) => void,
): Promise<Cookie[]> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
      `--window-size=800,600`,
    ]);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  if (!page) throw new Error('No page found');
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  const loginUrl = `https://${env}.${baseurl}/auth/www/index.aspx?ReturnUrl=%2f`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  if (username) {
    await page.locator(usernameSelector).fill(username);
    await page.locator(usernameContinueButtonSelector).click();

    const trimbleIdPage = await waitForTrimbleIdPage(browser, 4000);
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

      await waitForEBuilderHome(browser, env, onAccountSelected);
      return await context.cookies();
    }

    await page.locator(passwordSelector).waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(passwordSelector).fill(password);
    await page.locator(signInButtonSelector).click();

    const pollStart = Date.now();
    const pollTimeout = 30_000;
    while (Date.now() - pollStart < pollTimeout) {
      if (page.url().includes('/da2/Home/')) {
        break;
      }

      const errorMessageBox = page.locator(errorMessageSelector);
      if (await errorMessageBox.isVisible().catch(() => false)) {
        throw new Error(
          'Invalid username / password or account is locked or user already has maximum sessions open',
        );
      }

      if (page.url().includes(changePasswordUrl)) {
        throw new Error(
          'Password change required. Please login manually and change your password.',
        );
      }

      const accounts = await page
        .evaluate(() => {
          const mwcSelect = document.querySelector('#selectAccount') as any;
          if (!mwcSelect) return [];
          const rect = mwcSelect.getBoundingClientRect();
          const style = window.getComputedStyle(mwcSelect);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            (rect.width === 0 && rect.height === 0)
          ) {
            return [];
          }

          const mwcItems = Array.from(mwcSelect.querySelectorAll('mwc-list-item')) as any[];
          if (mwcItems.length > 0) {
            return mwcItems
              .map((item) => ({
                value: String(item.value || item.getAttribute?.('value') || '').trim(),
                text: String(item.textContent || '').trim(),
              }))
              .filter(
                (opt) =>
                  opt.value &&
                  opt.value !== '0' &&
                  opt.text &&
                  !opt.text.toLowerCase().includes('select account') &&
                  opt.text !== '-- Select --' &&
                  opt.text !== 'Select...',
              );
          }

          const nativeSelect =
            mwcSelect.shadowRoot?.querySelector('select') || mwcSelect.querySelector('select');
          if (nativeSelect) {
            return Array.from(nativeSelect.options as HTMLOptionElement[])
              .map((opt) => ({
                value: String(opt.value || '').trim(),
                text: String(opt.text || opt.textContent || '').trim(),
              }))
              .filter(
                (opt) =>
                  opt.value &&
                  opt.value !== '0' &&
                  opt.text &&
                  !opt.text.toLowerCase().includes('select account') &&
                  opt.text !== '-- Select --' &&
                  opt.text !== 'Select...',
              );
          }

          return [];
        })
        .catch(() => []);

      if (accounts.length > 0) {
        let chosenAccount: Account | undefined;
        if (account) {
          chosenAccount = accounts.find((a) => a.text.includes(account) || a.value === account);
          if (!chosenAccount && accountSpecifier) {
            chosenAccount = await accountSpecifier(accounts);
          }
        } else if (accounts.length === 1) {
          chosenAccount = accounts[0];
        } else if (accountSpecifier) {
          chosenAccount = await accountSpecifier(accounts);
        }

        if (chosenAccount) {
          const accountVal =
            typeof chosenAccount === 'object' && chosenAccount !== null
              ? chosenAccount.value
              : String(chosenAccount);
          const accountObj: Account =
            typeof chosenAccount === 'object' && chosenAccount !== null
              ? chosenAccount
              : (accounts.find((a) => a.value === accountVal) ?? {
                  value: accountVal,
                  text: accountVal,
                });

          onAccountSelected?.(accountObj);

          await page.evaluate((targetVal) => {
            const mwcSelect = document.querySelector('#selectAccount') as any;
            if (!mwcSelect) return;

            const mwcItems = Array.from(mwcSelect.querySelectorAll('mwc-list-item')) as any[];
            if (mwcItems.length > 0) {
              const idx = mwcItems.findIndex(
                (item) =>
                  String(item.value || item.getAttribute?.('value') || '').trim() === targetVal,
              );
              if (idx !== -1) {
                if (typeof mwcSelect.select === 'function') {
                  try {
                    mwcSelect.select(idx);
                  } catch {}
                }
                const targetItem = mwcItems[idx];
                if (targetItem) {
                  try {
                    targetItem.click();
                  } catch {}
                  targetItem.selected = true;
                  targetItem.setAttribute?.('selected', '');
                }
              }
            }

            try {
              mwcSelect.value = targetVal;
            } catch {}

            const nativeSelect =
              mwcSelect.shadowRoot?.querySelector('select') || mwcSelect.querySelector('select');
            if (nativeSelect) {
              nativeSelect.value = targetVal;
              const options = Array.from(nativeSelect.options) as HTMLOptionElement[];
              for (const opt of options) {
                opt.selected = String(opt.value).trim() === targetVal;
              }
              nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
              nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }

            mwcSelect.dispatchEvent(
              new CustomEvent('selected', {
                detail: { value: targetVal },
                bubbles: true,
              }),
            );
            mwcSelect.dispatchEvent(
              new CustomEvent('action', { detail: { value: targetVal }, bubbles: true }),
            );
            mwcSelect.dispatchEvent(new Event('input', { bubbles: true }));
            mwcSelect.dispatchEvent(new Event('change', { bubbles: true }));

            const selectedTextEl =
              mwcSelect.shadowRoot?.querySelector('.mdc-select__selected-text') ||
              mwcSelect.querySelector('.mdc-select__selected-text');
            const matchingAccount =
              mwcItems.find(
                (item) =>
                  String(item.value || item.getAttribute?.('value') || '').trim() === targetVal,
              ) ||
              (nativeSelect
                ? Array.from(nativeSelect.options).find(
                    (opt: any) => String(opt.value).trim() === targetVal,
                  )
                : null);
            if (selectedTextEl && matchingAccount) {
              const text = (matchingAccount.textContent || matchingAccount.text || '').trim();
              if (text) selectedTextEl.textContent = text;
            }

            const continueBtn = document.querySelector('#selectAccountContinueBtn') as any;
            if (continueBtn) {
              continueBtn.disabled = false;
              continueBtn.removeAttribute('disabled');
              continueBtn.click();
              const innerBtn =
                continueBtn.shadowRoot?.querySelector('button') ||
                continueBtn.querySelector('button');
              if (innerBtn) {
                innerBtn.disabled = false;
                innerBtn.removeAttribute('disabled');
                innerBtn.click();
              }
            }
          }, accountVal);

          break;
        }
      }

      await page.waitForTimeout(300);
    }

    await waitForEBuilderHome(browser, env, onAccountSelected);
  } else if (headless) {
    throw new Error('Username and password must be provided for headless mode');
  } else {
    await page.waitForSelector(usernameSelector);
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
    await waitForEBuilderHome(browser, env, onAccountSelected);
  }

  if (page.url().includes(changePasswordUrl)) {
    throw new Error('Password change required. Please login manually and change your password.');
  }

  const cookies = await context.cookies();
  return cookies;
}

export async function loginWithSso(
  env: Environment,
  ssoUrl: string,
  browser?: Browser,
): Promise<Cookie[]> {
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

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  if (!page) throw new Error('No page found');
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  await waitForEBuilderHome(browser, env);
  return await context.cookies();
}

export async function isLoggedIn(
  env: Environment,
  headless: boolean = true,
  cookies: Cookie[],
  browser?: Browser,
): Promise<{ isLoggedIn: boolean; newCookies: Cookie[] }> {
  let loggedIn = false;
  let newCookies: Cookie[] = [];
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }

  // Create a new browser context for isolation
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  // Set cookies
  await context.addCookies(normalizeCookies(cookies));
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
  cookies: Cookie[],
  browser?: Browser,
): Promise<void> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }

  // Create a new browser context for isolation
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  await context.addCookies(normalizeCookies(cookies));
  await page.goto(`https://${env}.${baseurl}/Login/Logout.aspx`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  // Close the context to clean up
  await context.close();
}
