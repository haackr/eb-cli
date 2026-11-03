import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';
import { waitForEBuilderPageToSettle } from './exec.js';
import { detectLoginPage, sessionCheckErrorFor } from './session-check.js';

/** Common options. `origin` overrides the environment URL (used by tests against a mock server). */
export interface SessionPageOptions {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  origin?: string | undefined;
}

/**
 * Opens an isolated browser context + page carrying the session cookies, runs `fn`, and always
 * cleans up. Safe to use with the shared warm-browser daemon.
 */
export async function withSessionPage<T>(
  options: SessionPageOptions,
  fn: (page: puppeteer.Page, origin: string) => Promise<T>,
  pageOptions: { blockAssets?: boolean; onPage?: (page: puppeteer.Page) => void } = {},
): Promise<T> {
  const browserInstance =
    options.browser ||
    (await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900'], false, {
      allowDaemon: true,
    }));
  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;
  try {
    await context.setCookie(...options.cookies);
    page = await context.newPage();
    await optimizePageForAutomation(page, { blockAssets: pageOptions.blockAssets ?? true });
    pageOptions.onPage?.(page);
    return await fn(page, options.origin ?? `https://${options.env}.${baseurl}`);
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/** Navigates and throws SessionExpiredError if e-Builder redirected to a login page. */
export async function gotoAuthenticated(
  page: puppeteer.Page,
  url: string,
  origin: string,
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForEBuilderPageToSettle(page);
  if (await detectLoginPage(page)) {
    throw sessionCheckErrorFor({ reason: 'redirected_to_login', landedUrl: page.url() }, origin);
  }
}
