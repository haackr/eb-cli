import puppeteer from "puppeteer";
import { Environment, baseurl, BrowserManager } from "./index.js";

// Selectors for the login page
const usernameSelector = "#txtUsername >>> #mwc_id_0_text_input";
const usernameContinueButtonSelector = "#usernameContinueBtn >>> button";
const passwordSelector = "#txtPassword >>> #mwc_id_1_text_input";
const signInButtonSelector = "#signIn >>> button";
const selectAccountSelector = "#selectAccount >>> #mwc_id_4_select";
const selectAccountContinueButtonSelector =
  "#selectAccountContinueBtn >>> button";
const myHomeTabSelector = "#ctl00_ucTopNav2_tabHomeLink";
const errorMessageSelector = "#errorMessage";

export type Account = {
  value: string;
  text: string;
};

async function getAccounts(
  accountOptions: puppeteer.ElementHandle[]
): Promise<Account[]> {
  let accounts: Account[] = [];
  for (let i = 1; i < accountOptions.length; i++) {
    const optionValue = await accountOptions[i]?.evaluate((el) => el.value);
    const optionText = await accountOptions[i]?.evaluate(
      (el) => el.textContent
    );
    accounts.push({ value: optionValue, text: optionText });
  }
  return accounts;
}

async function selectAccount(
  accountSelector: puppeteer.ElementHandle,
  account: string,
  accountOptions: Account[]
): Promise<void> {
  for (const option of accountOptions) {
    if (option.text.includes(account)) {
      console.log("Found account");
      await accountSelector?.select(option.value);
      break;
    }
  }
}

export async function login(
  env: Environment,
  headless: boolean = false,
  username?: string,
  password?: string,
  account?: string,
  accountSpecifier?: Function,
  browser?: puppeteer.Browser
): Promise<puppeteer.Cookie[]> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
      `--window-size=800,600`,
    ]);
  }
  const [page] = await browser.pages();

  if (!page) throw new Error("No page found");

  const loginUrl = `https://${env}.${baseurl}/auth/www/index.aspx?ReturnUrl=%2f`;
  await page.goto(loginUrl);

  if (username && password) {
    await page.locator(usernameSelector).fill(username);
    await page.locator(usernameContinueButtonSelector).click();
    await page.waitForNavigation();

    await page.locator(passwordSelector).fill(password);
    await page.locator(signInButtonSelector).click();
    await page.waitForNetworkIdle();
    const errorMessageBox = await page.$(errorMessageSelector);
    if (errorMessageBox && (await errorMessageBox.isVisible()))
      throw new Error(
        "Invalid username / password or account is locked or user already has maximum sessions open"
      );
    // await page.waitForNavigation();

    if (account) {
      console.log(account);
      const accountSelector = await page.waitForSelector(selectAccountSelector);
      if (!accountSelector) throw new Error("Account selector not found");
      const accountOptions = await page.$$(selectAccountSelector + " option");
      const accounts = await getAccounts(accountOptions);
      await selectAccount(accountSelector, account, accounts);
      await page.locator(selectAccountContinueButtonSelector).click();
      await page.waitForNavigation();
    } else {
      const accountSelector = await page.$(selectAccountSelector);
      if (accountSelector && headless) {
        const accountOpttions = await page.$$(
          selectAccountSelector + " option"
        );
        const accounts = await getAccounts(accountOpttions);
        if (!accountSpecifier)
          throw new Error("Account specifier must be provided");
        const selectedAccount = await accountSpecifier(accounts);
        await accountSelector?.select(selectedAccount);
        await page.locator(selectAccountContinueButtonSelector).click();
        await page.waitForNavigation();
      } else {
        await page.waitForNavigation();
      }
    }
  } else if (headless) {
    throw new Error("Username and password must be provided for headless mode");
  } else {
    await page.waitForSelector(usernameSelector);
    await page.waitForNavigation();
    await page.waitForSelector(passwordSelector);
    await page.waitForNavigation();
    if (await page.$(selectAccountSelector)) {
      await page.waitForNavigation();
    }
  }

  const cookies = await browser.cookies();
  return cookies;
}

export async function isLoggedIn(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser
): Promise<{ isLoggedIn: boolean; newCookies: puppeteer.Cookie[] }> {
  let loggedIn = false;
  let newCookies: puppeteer.Cookie[] = [];
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }
  const [page] = await browser.pages();
  if (!page) throw new Error("No page found");
  await browser.setCookie(...cookies);
  await page.goto(`https://${env}.${baseurl}/da2/Home/index2.aspx`);
  try {
    await page.waitForSelector(myHomeTabSelector, {
      timeout: 5000,
    });
    loggedIn = true;
    newCookies = await browser.cookies();
  } catch (error) {
    loggedIn = false;
  }
  return { isLoggedIn: loggedIn, newCookies: newCookies };
}

export async function logout(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser
): Promise<void> {
  if (!browser) {
    browser = await BrowserManager.getInstance().getBrowser(headless, [
      `--app=http://${env}.${baseurl}`,
    ]);
  }
  await browser.setCookie(...cookies);
  let [page] = await browser.pages();
  if (!page) page = await browser.newPage();
  await page.goto(`https://${env}.${baseurl}/Login/Logout.aspx`);
}
