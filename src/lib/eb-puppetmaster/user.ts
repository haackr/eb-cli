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

const userNameInput = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_txtUserName';
const filterButton = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnFilter';
const selectFirstCheckbox = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_grdResults_ctl03_cbox';
const deleteButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnRemove';
const confirmButtonSelector = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnYes';
const cancelButton = '#ctl00_ctl00_ContentPlaceHolder1_contentSection_btnNo';

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
