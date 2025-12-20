import puppeteer from "puppeteer";

const baseurl = "e-builder.net";

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

export enum Environment {
  US1 = "app",
  US2 = "app-us2",
  US3 = "app-us3",
  US4 = "app-us4",
  GOV = "gov",
  CA = "app.ca",
}

export async function login(
  env: Environment,
  headless: boolean = false,
  username?: string,
  password?: string,
  account?: string,
  browser?: puppeteer.Browser
): Promise<puppeteer.Cookie[]> {
  let thisCreatedBrowser = false;
  if (!browser) {
    browser = await puppeteer.launch({
      headless,
      args: [`--app=http://${env}.${baseurl}`, `--window-size=800,600`],
    });
    thisCreatedBrowser = true;
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
    console.log(await errorMessageBox?.isVisible());
    if (await errorMessageBox?.isVisible())
      throw new Error("Invalid username / password or account is locked");
    await page.waitForNavigation();

    if (account) {
      console.log(account);
      await page.locator(selectAccountSelector).fill(account);
      await page.locator(selectAccountContinueButtonSelector).click();
    } else {
      await page.$(selectAccountSelector);
    }
  } else if (headless) {
    if (thisCreatedBrowser) {
      await browser.close();
    }
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
  if (thisCreatedBrowser) {
    await browser.close();
  }
  return cookies;
}

export async function isLoggedIn(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser
): Promise<boolean> {
  let thisCreatedBrowser = false;
  let loggedIn = false;
  if (!browser) {
    browser = await puppeteer.launch({
      headless,
      args: [`--app=http://${env}.${baseurl}`],
    });
    thisCreatedBrowser = true;
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
  } catch (error) {
    loggedIn = false;
  }
  if (thisCreatedBrowser) {
    await browser.close();
  }
  return loggedIn;
}

export async function logout(
  env: Environment,
  headless: boolean = true,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser
): Promise<void> {
  let thisCreatedBrowser = false;
  if (!browser) {
    browser = await puppeteer.launch({
      headless,
      args: [`--app=http://${env}.${baseurl}`],
    });
    thisCreatedBrowser = true;
  }
  await browser.setCookie(...cookies);
  let [page] = await browser.pages();
  if (!page) page = await browser.newPage();
  await page.goto(`https://${env}.${baseurl}/Login/Logout.aspx`);
  if (thisCreatedBrowser) {
    await browser.close();
  }
}
