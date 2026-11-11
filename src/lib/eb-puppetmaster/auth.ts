import type * as puppeteer from 'puppeteer';
import { Environment, baseurl, BrowserManager } from './index.js';
import {
  classifyNavigationError,
  isLoginUrl,
  detectLoginPage,
  safePageUrl,
  type SessionCheckResult,
} from './session-check.js';

// Selectors for the login page
const usernameSelector =
  '#ctl00_ContentPlaceHolder1_txtUserName, #txtUsername >>> #mwc_id_0_text_input, #txtUsername, input[name*="txtUserName"], input[name*="UserName"]';
const passwordSelector =
  '#ctl00_ContentPlaceHolder1_txtPassword, #txtPassword >>> #mwc_id_1_text_input, #txtPassword, input[name*="Password"]';
const signInButtonSelector =
  '#ctl00_ContentPlaceHolder1_btnLogin, #signIn >>> button, #signIn, input[value="Log In"], input[type="submit"]';
const selectAccountSelector =
  '#ctl00_ContentPlaceHolder1_ddlAccounts, #selectAccount >>> select, select[name*="Account"], select';
const selectAccountContinueButtonSelector =
  '#ctl00_ContentPlaceHolder1_btnNext, #selectAccountContinueBtn >>> button, #selectAccountContinueBtn, input[value="Next"], input[type="submit"]';
const myHomeTabSelector = '#ctl00_ucTopNav2_tabHomeLink';
const errorMessageSelector = '#errorMessage';
const changePasswordUrl = '/auth/Authenticate/LoginSequence.aspx';

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
  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    return host === 'id.trimble.com' || host.endsWith('.id.trimble.com');
  } catch {
    return false;
  }
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
  const isEBuilderDomain =
    url.hostname === eBuilderHost ||
    url.hostname === 'app.e-builder.net' ||
    url.hostname.endsWith('.e-builder.net');
  if (!isEBuilderDomain) return false;

  const path = url.pathname.toLowerCase();
  if (isLoginUrl(url.href) || path.includes('signin')) {
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
    const isEBuilderDomain =
      url.hostname === eBuilderHost ||
      url.hostname === 'app.e-builder.net' ||
      url.hostname.endsWith('.e-builder.net');
    if (!isEBuilderDomain) return false;

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
  targetAccount?: string,
  accountSpecifier?: Function,
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

      const isEBuilderDomain =
        url.hostname === eBuilderHost ||
        url.hostname === 'app.e-builder.net' ||
        url.hostname.endsWith('.e-builder.net');
      if (!isEBuilderDomain) continue;

      if (
        isEBuilderAuthenticatedUrl(url, env) ||
        (await isEBuilderPageAuthenticated(openPage, env))
      ) {
        return openPage;
      }

      if (targetAccount || accountSpecifier) {
        try {
          const resolved = await tryResolveAccountSelection(
            openPage,
            targetAccount,
            accountSpecifier,
            onAccountSelected,
          );
          if (resolved) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
        } catch (error) {
          if (isNavigationRace(error)) continue;
        }
      }

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
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error('Timed out waiting for authentication to redirect to e-Builder.');
}

const bypassPasskeyScript = `
(() => {
  try {
    if (!window.navigator) return;
    if (!window.navigator.credentials) {
      window.navigator.credentials = {};
    }
    window.navigator.credentials.get = async function(...args) {
      console.log('[eb-cli] Bypassing passkey WebAuthn prompt automatically');
      throw new DOMException('Passkey bypassed by CLI automation', 'NotAllowedError');
    };
  } catch (e) {}
})();
`;

async function setupPasskeyBypass(
  browser: puppeteer.Browser,
  page?: puppeteer.Page,
): Promise<void> {
  if (page) {
    await page.evaluateOnNewDocument(bypassPasskeyScript).catch(() => {});
    await page.evaluate(bypassPasskeyScript).catch(() => {});
  }
  browser.on('targetcreated', async (target) => {
    try {
      const p = await target.page();
      if (p) {
        await p.evaluateOnNewDocument(bypassPasskeyScript).catch(() => {});
        await p.evaluate(bypassPasskeyScript).catch(() => {});
      }
    } catch {}
  });
}

async function tryResolveAccountSelection(
  page: puppeteer.Page,
  targetAccount?: string,
  accountSpecifier?: Function,
  onAccountSelected?: (account: Account) => void,
): Promise<boolean> {
  const hasAccountSelector = await page
    .evaluate(() => {
      return Boolean(
        document.querySelector('#selectAccount') ||
        document.querySelector('#ctl00_ContentPlaceHolder1_ddlAccounts') ||
        document.querySelector('select[name*="Account"]') ||
        document.querySelector('modus-select'),
      );
    })
    .catch(() => false);

  if (!hasAccountSelector) return false;

  const accounts: Account[] = await page
    .evaluate(() => {
      const list: { value: string; text: string }[] = [];

      const selects = Array.from(document.querySelectorAll('select'));
      const modusSelect = document.querySelector('modus-select, #selectAccount');
      if (modusSelect && modusSelect.shadowRoot) {
        const shadowSelect = modusSelect.shadowRoot.querySelector('select');
        if (shadowSelect) selects.push(shadowSelect);
      }

      if (
        modusSelect &&
        (modusSelect as any).options &&
        Array.isArray((modusSelect as any).options)
      ) {
        for (const opt of (modusSelect as any).options) {
          list.push({
            value: String(opt.value ?? opt.id ?? ''),
            text: String(opt.label ?? opt.display ?? opt.text ?? ''),
          });
        }
      }

      for (const select of selects) {
        for (let i = 0; i < select.options.length; i++) {
          const opt = select.options[i];
          if (
            opt &&
            opt.value &&
            opt.text &&
            !opt.text.toLowerCase().includes('select an account')
          ) {
            list.push({ value: opt.value, text: opt.text.trim() });
          }
        }
      }

      const unique = new Map<string, { value: string; text: string }>();
      for (const item of list) {
        if (item.value && !unique.has(item.value)) {
          unique.set(item.value, item);
        }
      }
      return Array.from(unique.values());
    })
    .catch(() => []);

  if (accounts.length === 0) {
    return false;
  }

  let selectedValue: string | undefined;
  let selectedText: string | undefined;

  if (targetAccount) {
    const match = accounts.find((a) => a.text.toLowerCase().includes(targetAccount.toLowerCase()));
    if (match) {
      selectedValue = match.value;
      selectedText = match.text;
    }
  }

  if (!selectedValue && accountSpecifier) {
    const chosen = await accountSpecifier(accounts);
    if (typeof chosen === 'string') {
      selectedValue = chosen;
      selectedText = accounts.find((a) => a.value === chosen)?.text;
    } else if (chosen && chosen.value) {
      selectedValue = chosen.value;
      selectedText = chosen.text;
    }
  }

  if (!selectedValue && accounts.length === 1) {
    selectedValue = accounts[0]?.value;
    selectedText = accounts[0]?.text;
  }

  if (!selectedValue) {
    return false;
  }

  if (selectedText && onAccountSelected) {
    onAccountSelected({ value: selectedValue, text: selectedText });
  }

  const clicked = await page
    .evaluate((val) => {
      let changed = false;

      const selects = Array.from(document.querySelectorAll('select'));
      const modusSelect = document.querySelector('modus-select, #selectAccount');
      if (modusSelect) {
        try {
          (modusSelect as any).value = val;
          modusSelect.dispatchEvent(new CustomEvent('valueChange', { detail: val }));
        } catch {}
        if (modusSelect.shadowRoot) {
          const shadowSelect = modusSelect.shadowRoot.querySelector('select');
          if (shadowSelect) selects.push(shadowSelect);
        }
      }

      for (const select of selects) {
        select.value = val;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        changed = true;
      }

      const mwcBtn = document.querySelector(
        '#selectAccountContinueBtn, modus-button[id*="Continue"]',
      );
      if (mwcBtn) {
        mwcBtn.removeAttribute('disabled');
        (mwcBtn as any).disabled = false;
        const shadowBtn = mwcBtn.shadowRoot?.querySelector<HTMLElement>('button');
        if (shadowBtn) {
          shadowBtn.removeAttribute('disabled');
          (shadowBtn as any).disabled = false;
          shadowBtn.click();
        }
        (mwcBtn as HTMLElement).click();
        return true;
      }

      const stdBtn = document.querySelector<HTMLElement>(
        '#ctl00_ContentPlaceHolder1_btnNext, input[value="Next"], input[type="submit"]',
      );
      if (stdBtn) {
        stdBtn.click();
        return true;
      }

      return changed;
    }, selectedValue)
    .catch(() => false);

  return clicked;
}

async function domClick(page: puppeteer.Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
      }
      return false;
    }, selector);
  } catch {
    return false;
  }
}

async function domType(
  page: puppeteer.Page,
  selector: string,
  text: string,
  elementHandle?: puppeteer.ElementHandle | null,
): Promise<boolean> {
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    }, selector);

    if (elementHandle) {
      await elementHandle.focus().catch(() => {});
    }

    await page.keyboard.type(text, { delay: 40 });

    return await page.evaluate(
      (sel, val) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) {
          if (el.value !== val) {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value',
            )?.set;
            if (setter) {
              setter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          return true;
        }
        return false;
      },
      selector,
      text,
    );
  } catch {
    return false;
  }
}

async function completeTrimbleIdLogin(
  browser: puppeteer.Browser,
  page: puppeteer.Page,
  env: Environment,
  headless: boolean,
  username?: string,
  password?: string,
  onAccountSelected?: (account: Account) => void,
  getTotp?: () => Promise<string | undefined>,
  targetAccount?: string,
  accountSpecifier?: Function,
): Promise<puppeteer.Cookie[]> {
  let authBrowser = browser;
  let authPage = page;

  // If headless is requested and we have automated credentials (username, password, getTotp),
  // stay headless! Only launch a visible browser if human interactive input is needed.
  if (headless && !(username && password && getTotp)) {
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

  if (getTotp) {
    await setupPasskeyBypass(authBrowser, authPage);
  }

  // 1. Trimble ID Username
  if (username) {
    const usernameInput = await authPage
      .waitForSelector('#username-field, #username_email, input[name="username"]', {
        visible: true,
        timeout: 15_000,
      })
      .catch(() => null);

    if (usernameInput) {
      await domType(
        authPage,
        '#username-field, #username_email, input[name="username"]',
        username,
        usernameInput,
      );
      await new Promise((r) => setTimeout(r, 200));
      await authPage.evaluate(() => {
        const nextBtn =
          document.querySelector<HTMLButtonElement>('#enter_username_submit') ||
          document.querySelector<HTMLButtonElement>('button[name="username-submit"]') ||
          Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
            const txt = (b.textContent || '').trim().toLowerCase();
            return (
              (txt === 'next' ||
                txt === 'continue' ||
                txt.includes('next') ||
                txt.includes('continue')) &&
              !txt.includes('passkey') &&
              !txt.includes('different')
            );
          });
        if (nextBtn) {
          nextBtn.removeAttribute('disabled');
          (nextBtn as any).disabled = false;
          nextBtn.click();
        }
      });
      await authPage.keyboard.press('Enter').catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 2. Trimble ID Password
  if (password) {
    const passwordInput = await authPage.waitForSelector(
      '#login-password-input, input[name="password"], input[type="password"], #password',
      {
        visible: true,
        timeout: 30_000,
      },
    );

    if (passwordInput) {
      await domType(
        authPage,
        '#login-password-input, input[name="password"], input[type="password"], #password',
        password,
        passwordInput,
      );
      await new Promise((r) => setTimeout(r, 300));
      await authPage.evaluate(() => {
        const signInBtn =
          document.querySelector<HTMLButtonElement>('button[name="password-submit"]') ||
          document.querySelector<HTMLButtonElement>('#button_sign_in') ||
          Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => {
            const txt = (b.textContent || '').trim().toLowerCase();
            return (
              (txt === 'sign in' ||
                txt === 'continue' ||
                txt.includes('sign in') ||
                txt.includes('continue')) &&
              !txt.includes('passkey') &&
              !txt.includes('forgot') &&
              !txt.includes('different')
            );
          });
        if (signInBtn) {
          signInBtn.removeAttribute('disabled');
          (signInBtn as any).disabled = false;
          signInBtn.click();
        }
      });
      await authPage.keyboard.press('Enter').catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 3. Handle Trimble ID 2FA (passkey or verification code / TOTP)
  try {
    const mfaTimeout = Date.now() + 120_000;
    let totpSubmitted = false;
    let lastSubmitTime = 0;

    while (Date.now() < mfaTimeout) {
      const currentUrl = authPage.url();
      if (currentUrl.includes('e-builder.net')) {
        break;
      }

      // Check for account lockout or rate limiting
      const maxAttemptsError = await authPage
        .evaluate(() => {
          const text = document.body?.innerText?.toLowerCase() || '';
          return (
            text.includes('maximum number of attempts') ||
            text.includes('too many attempts') ||
            text.includes('account has been locked')
          );
        })
        .catch(() => false);
      if (maxAttemptsError) {
        throw new Error(
          'Trimble ID: You have reached the maximum number of attempts. Please try again later.',
        );
      }

      // Check if code was rejected and needs retry
      const hasCodeError = await authPage
        .evaluate(() => {
          const text = document.body?.innerText?.toLowerCase() || '';
          return (
            (text.includes('invalid code') ||
              text.includes('incorrect code') ||
              text.includes('code is incorrect') ||
              text.includes('the code you entered')) &&
            !text.includes('maximum number of attempts')
          );
        })
        .catch(() => false);
      if (hasCodeError && totpSubmitted) {
        console.log('[eb-cli] Code rejection detected. Retrying with fresh TOTP...');
        totpSubmitted = false;
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Check for verification code input
      const hasCodeInput = await authPage
        .evaluate(() => {
          const el = document.querySelector<HTMLInputElement>(
            '#mfa-totp-code-input, #verification_code, input[autocomplete="one-time-code"], input[name="code"], input[name="verification_code"], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]',
          );
          return Boolean(el);
        })
        .catch(() => false);

      if (hasCodeInput) {
        if (getTotp && !totpSubmitted) {
          console.log('[eb-cli] Verification code input detected. Resolving live TOTP...');
          const totp = await getTotp();
          if (totp) {
            console.log('[eb-cli] Typing TOTP code and submitting...');

            const totpSelector =
              '#mfa-totp-code-input, #verification_code, input[autocomplete="one-time-code"], input[name="code"], input[name="verification_code"], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]';
            const totpInput = await authPage.$(totpSelector);
            await domType(authPage, totpSelector, totp, totpInput);

            totpSubmitted = true;
            lastSubmitTime = Date.now();
            await new Promise((r) => setTimeout(r, 300));

            // Press Enter on the input
            await authPage.keyboard.press('Enter').catch(() => {});
            await new Promise((r) => setTimeout(r, 400));

            // Also click any submit / verify / continue button
            await authPage.evaluate(() => {
              const submitBtn =
                document.querySelector<HTMLButtonElement>('#enter_verification_code_submit') ||
                document.querySelector<HTMLButtonElement>('button[name="submit"]') ||
                document.querySelector<HTMLButtonElement>('button[type="submit"]') ||
                Array.from(
                  document.querySelectorAll<HTMLButtonElement>('button, input[type="submit"]'),
                ).find((b) => {
                  const txt = (b.textContent || (b as HTMLInputElement).value || '')
                    .trim()
                    .toLowerCase();
                  return (
                    (txt === 'submit' ||
                      txt === 'verify' ||
                      txt === 'continue' ||
                      txt === 'next') &&
                    !txt.includes('passkey') &&
                    !txt.includes('email') &&
                    !txt.includes('cancel') &&
                    !txt.includes('recover')
                  );
                });
              if (submitBtn) {
                submitBtn.removeAttribute('disabled');
                (submitBtn as any).disabled = false;
                submitBtn.click();
              }
            });

            console.log('[eb-cli] Submitted TOTP verification code.');
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
        } else if (totpSubmitted && Date.now() - lastSubmitTime > 6000) {
          console.log('[eb-cli] Still on verification page. Retrying submission...');
          await authPage.keyboard.press('Enter').catch(() => {});
          await authPage.evaluate(() => {
            const submitBtn =
              document.querySelector<HTMLButtonElement>('#enter_verification_code_submit') ||
              document.querySelector<HTMLButtonElement>('button[name="submit"]') ||
              document.querySelector<HTMLButtonElement>('button[type="submit"]') ||
              Array.from(
                document.querySelectorAll<HTMLButtonElement>('button, input[type="submit"]'),
              ).find((b) => {
                const txt = (b.textContent || (b as HTMLInputElement).value || '')
                  .trim()
                  .toLowerCase();
                return (
                  (txt === 'submit' || txt === 'verify' || txt === 'continue' || txt === 'next') &&
                  !txt.includes('passkey') &&
                  !txt.includes('email') &&
                  !txt.includes('cancel') &&
                  !txt.includes('recover')
                );
              });
            if (submitBtn) {
              submitBtn.removeAttribute('disabled');
              (submitBtn as any).disabled = false;
              submitBtn.click();
            }
          });
          if (Date.now() - lastSubmitTime > 15000) {
            totpSubmitted = false;
          }
        }
      }

      // If we have TOTP available but the code input is NOT present yet,
      // click "More options" or choose "Authenticator"
      if (getTotp && !totpSubmitted && !hasCodeInput) {
        await authPage.evaluate(() => {
          const allElements = Array.from(
            document.querySelectorAll('a, button, [role="button"], li, div[role="link"], span'),
          );

          // First, see if an authenticator / verification code option is directly listed
          const authOption = allElements.find((el) => {
            const txt = (el.textContent || '').trim().toLowerCase();
            return (
              (txt.includes('authenticator') ||
                txt.includes('verification code') ||
                txt.includes('one-time code')) &&
              !txt.includes('passkey')
            );
          });
          if (authOption && authOption instanceof HTMLElement) {
            authOption.click();
            return;
          }

          // Otherwise look for "More options" or "Try another way" / "different method"
          const moreOptions = allElements.find((el) => {
            const txt = (el.textContent || '').trim().toLowerCase();
            return (
              txt.includes('more options') ||
              txt.includes('another way') ||
              txt.includes('other options') ||
              txt.includes('different method')
            );
          });
          if (moreOptions && moreOptions instanceof HTMLElement) {
            moreOptions.click();
          }
        });
      }

      // If no TOTP handler was provided, fall back to passkey button
      if (!getTotp) {
        const clicked = await domClick(authPage, '#button_verify_passkey');
        if (!clicked) {
          await authPage.evaluate(() => {
            const passkeyBtn = Array.from(
              document.querySelectorAll<HTMLButtonElement>('button'),
            ).find((b) => {
              const txt = (b.textContent || '').trim().toLowerCase();
              return txt.includes('passkey') || txt.includes('use a passkey');
            });
            passkeyBtn?.click();
          });
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('maximum number of attempts')) {
      throw error;
    }
    // Continue waiting for redirect
  }

  await waitForEBuilderHome(authBrowser, env, onAccountSelected, targetAccount, accountSpecifier);
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
  getTotp?: () => Promise<string | undefined>,
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

  if (getTotp) {
    await setupPasskeyBypass(browser, page);
  }

  const loginUrl = `https://${env}.${baseurl}/auth/www/index.aspx?ReturnUrl=%2f`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  if (username) {
    await page.waitForFunction(
      () => {
        return (
          document.querySelector('#txtUsername') !== null ||
          document.querySelector('#ctl00_ContentPlaceHolder1_txtUserName') !== null ||
          document.querySelector('input[type="email"]') !== null
        );
      },
      { timeout: 30_000 },
    );

    await page.evaluate((uname) => {
      const mwc = document.querySelector<HTMLElement & { value?: string }>('#txtUsername');
      if (mwc) {
        mwc.value = uname;
        mwc.dispatchEvent(new CustomEvent('valueChange', { detail: uname }));
      }
      const shadowInput = mwc?.shadowRoot?.querySelector<HTMLInputElement>('input');
      if (shadowInput) {
        shadowInput.focus();
        shadowInput.value = uname;
        shadowInput.dispatchEvent(new Event('input', { bubbles: true }));
        shadowInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const standardInput = document.querySelector<HTMLInputElement>(
        '#ctl00_ContentPlaceHolder1_txtUserName, input[name*="UserName"], input[type="email"]',
      );
      if (standardInput) {
        standardInput.focus();
        standardInput.value = uname;
        standardInput.dispatchEvent(new Event('input', { bubbles: true }));
        standardInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, username);

    await new Promise((r) => setTimeout(r, 500));

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      page.evaluate(() => {
        const mwcBtn = document.querySelector('#usernameContinueBtn');
        const shadowBtn = mwcBtn?.shadowRoot?.querySelector<HTMLElement>('button');
        if (shadowBtn && !shadowBtn.hasAttribute('disabled')) {
          shadowBtn.click();
          return;
        }
        if (mwcBtn instanceof HTMLElement) {
          mwcBtn.click();
          return;
        }
        const standardBtn = document.querySelector<HTMLElement>(
          '#ctl00_ContentPlaceHolder1_btnNext, input[value="Next"], input[type="submit"]',
        );
        standardBtn?.click();
      }),
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
        getTotp,
        account,
        accountSpecifier,
      );
    }

    if (!password) {
      if (headless) {
        throw new Error('Password must be provided for headless mode.');
      }

      await waitForEBuilderHome(browser, env, onAccountSelected, account, accountSpecifier);
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
        getTotp,
        account,
        accountSpecifier,
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

/**
 * Navigates to the e-Builder home page with the given cookies and reports whether the session
 * is authenticated. Never throws for navigation failures: network errors, timeouts, and HTTP 5xx
 * responses are reported via `reason` so callers can avoid treating them as expired sessions.
 */
export async function isLoggedIn(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser,
): Promise<SessionCheckResult> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(
      headless,
      [`--app=http://${env}.${baseurl}`],
      false,
      { allowDaemon: true },
    );
  }

  // Create a new browser context for isolation
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(90_000);

  try {
    let response: puppeteer.HTTPResponse | null | undefined;
    try {
      await context.setCookie(...cookies);
      response = await page.goto(`https://${env}.${baseurl}/da2/Home/index2.aspx`, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
    } catch (err) {
      return {
        isLoggedIn: false,
        reason: classifyNavigationError(err) ?? 'unknown',
        errorMessage: err instanceof Error ? err.message : String(err),
        landedUrl: safePageUrl(page),
        newCookies: [],
      };
    }

    let loggedIn = false;
    try {
      await page.waitForSelector(myHomeTabSelector, { timeout: 5000 });
      loggedIn = true;
    } catch {
      if (typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => null);
      }
      loggedIn = await isEBuilderPageAuthenticated(page, env);
    }

    const landedUrl = safePageUrl(page);
    if (loggedIn) {
      return {
        isLoggedIn: true,
        reason: 'authenticated',
        landedUrl,
        newCookies: await context.cookies(),
      };
    }

    if (await detectLoginPage(page)) {
      return { isLoggedIn: false, reason: 'redirected_to_login', landedUrl, newCookies: [] };
    }

    const status = typeof response?.status === 'function' ? response.status() : undefined;
    if (status !== undefined && status >= 500) {
      return {
        isLoggedIn: false,
        reason: 'server_error',
        errorMessage: `HTTP ${status}`,
        landedUrl,
        newCookies: [],
      };
    }

    return {
      isLoggedIn: false,
      reason: 'unknown',
      errorMessage: 'Authenticated page markers not found',
      landedUrl,
      newCookies: [],
    };
  } finally {
    await context.close().catch(() => {});
  }
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
