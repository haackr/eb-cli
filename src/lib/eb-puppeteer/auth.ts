import puppeteer from "puppeteer";

const baseurl = "e-builder.net";
const usernameSelector = "#txtUsername >>> #mwc_id_0_text_input";
const usernameContinueButtonSelector = "#usernameContinueBtn >>> button";
const passwordSelector = "#txtPassword >>> #mwc_id_1_text_input";
const signInButtonSelector = "#signIn >>> button";
const selectAccountSelector = "#selectAccount >>> #mwc_id_4_select";
const selectAccountContinueButtonSelector =
  "#selectAccountContinueBtn >>> button";
const profileMenuSelector = ".profile-menu >>> .sign-out";

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
    browser = await puppeteer.launch({ headless });
    thisCreatedBrowser = true;
  }
  const page = await browser.newPage();

  const loginUrl = `https://${env}.${baseurl}/auth/www/index.aspx?ReturnUrl=%2f`;
  await page.goto(loginUrl);

  if (username && password) {
    await page.locator(usernameSelector).fill(username);
    await page.locator(usernameContinueButtonSelector).click();

    await page.locator(passwordSelector).fill(password);
    await page.locator(signInButtonSelector).click();

    if (account) {
      await page.locator(selectAccountSelector).fill(account);
      await page.locator(selectAccountContinueButtonSelector).click();
    }
  } else if (headless) {
    if (thisCreatedBrowser) {
      await browser.close();
    }
    throw new Error("Username and password must be provided for headless mode");
  }

  const cookies = await browser.cookies();
  if (thisCreatedBrowser) {
    await browser.close();
  }
  return cookies;
}

export async function isLoggedIn(
  env: Environment,
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser,
  headless: boolean = true
): Promise<boolean> {
  let thisCreatedBrowser = false;
  let loggedIn = false;
  if (!browser) {
    browser = await puppeteer.launch({ headless });
    thisCreatedBrowser = true;
  }
  const page = await browser.newPage();
  await browser.setCookie(...cookies);
  await page.goto(`https://${env}.${baseurl}/da2/Home/index2.aspx`);
  try {
    await page.waitForSelector("modus-navbar-profile-menu >>> .sign-out", {
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
  cookies: puppeteer.Cookie[],
  browser?: puppeteer.Browser,
  headless: boolean = true
): Promise<void> {
  let thisCreatedBrowser = false;
  if (!browser) {
    browser = await puppeteer.launch({ headless });
    thisCreatedBrowser = true;
  }
  const page = await browser.newPage();
  await browser.setCookie(...cookies);
  await page.goto(`https://${env}.${baseurl}/Login/Logout.aspx`);
  if (thisCreatedBrowser) {
    await browser.close();
  }
}
