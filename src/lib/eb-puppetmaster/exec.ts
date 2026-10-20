import puppeteer from 'puppeteer';
import { baseurl, BrowserManager, Environment, optimizePageForAutomation } from './index.js';

export type ExecuteInSessionMode = 'dom' | 'puppeteer';

export type ExecuteInSessionOptions = {
  env: Environment;
  cookies: puppeteer.Cookie[];
  browser?: puppeteer.Browser | undefined;
  headless?: boolean | undefined;
  url?: string | undefined;
  waitForSelector?: string | undefined;
  script?: string | undefined;
  mode?: ExecuteInSessionMode | undefined;
  arg?: unknown;
  screenshotPath?: string | undefined;
  blockAssets?: boolean | undefined;
};

export type ExecuteInSessionResult = {
  url: string;
  title: string;
  frameUrl: string | null;
  result: unknown;
  cookies: puppeteer.Cookie[];
  screenshotPath: string | null;
};

export type PuppeteerExecContext = {
  page: puppeteer.Page;
  browser: puppeteer.Browser;
  context: puppeteer.BrowserContext;
  env: Environment;
  origin: string;
  url: string;
  arg: unknown;
  settle: () => Promise<void>;
};

const EBUILDER_HOST_PATTERN = /(^|\.)e-builder\.(net|ca)$/i;

/**
 * Resolves a relative path or full URL to the active e-Builder session's environment origin.
 * If a full e-Builder URL is provided with a different environment subdomain (e.g., app-us2 vs app),
 * it is rewritten to the session's authenticated environment origin to prevent accidental logouts.
 */
export function resolveSessionUrl(env: Environment, pathOrUrl?: string): string {
  const origin = `https://${env}.${baseurl}`;
  const trimmed = pathOrUrl?.trim();

  if (!trimmed) {
    return `${origin}/da2/Home/index2.aspx`;
  }

  if (/^(data|about|file):/i.test(trimmed)) {
    return trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (EBUILDER_HOST_PATTERN.test(parsed.hostname)) {
      return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.href;
  }

  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${origin}${normalizedPath}`;
}

/**
 * Waits for an e-Builder ASP.NET WebForms page (and its inner #contentFrame iframe, if present)
 * to finish loading, async postbacks, and jQuery AJAX requests.
 */
export async function waitForEBuilderPageToSettle(
  page: puppeteer.Page,
  timeoutMs: number = 15_000,
): Promise<void> {
  if (typeof page.waitForFunction === 'function') {
    await page
      .waitForFunction(
        () => {
          const checkWindowIdle = (
            win: Window | null | undefined,
            doc: Document | null | undefined,
          ) => {
            if (!win || !doc) return true;
            if (doc.readyState !== 'complete') return false;

            const prm = (win as any).Sys?.WebForms?.PageRequestManager?.getInstance?.();
            const isPostBackIdle = !(prm?.get_isInAsyncPostBack?.() ?? false);

            const isJQueryIdle =
              typeof (win as any).jQuery === 'undefined' || ((win as any).jQuery.active ?? 0) === 0;

            return isPostBackIdle && isJQueryIdle;
          };

          if (!checkWindowIdle(window, document)) {
            return false;
          }

          const iframe = document.querySelector<HTMLIFrameElement>(
            'iframe#contentFrame, iframe[name="contentFrame"], iframe',
          );
          if (iframe) {
            try {
              if (!checkWindowIdle(iframe.contentWindow, iframe.contentDocument)) {
                return false;
              }
            } catch {
              // Cross-origin iframe; ignore
            }
          }

          return true;
        },
        { timeout: timeoutMs },
      )
      .catch(() => null);
  }

  if (typeof page.waitForNetworkIdle === 'function') {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5_000 }).catch(() => null);
  }
}

async function waitForSelectorInPageOrFrame(
  page: puppeteer.Page,
  selector: string,
  timeoutMs: number = 30_000,
): Promise<void> {
  if (typeof page.waitForFunction === 'function') {
    await page.waitForFunction(
      (sel) => {
        if (document.querySelector(sel)) return true;
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe#contentFrame, iframe[name="contentFrame"], iframe',
        );
        try {
          if (iframe?.contentDocument?.querySelector(sel)) return true;
        } catch {}
        return false;
      },
      { timeout: timeoutMs },
      selector,
    );
    return;
  }

  if (typeof page.waitForSelector === 'function') {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  }
}

async function evaluateDomScript(
  page: puppeteer.Page,
  script: string,
  arg: unknown,
): Promise<unknown> {
  return await page.evaluate(
    async (code: string, passedArg: unknown) => {
      try {
        const evaluated = (0, eval)(`(${code})`);
        if (typeof evaluated === 'function') {
          return await evaluated(passedArg);
        }
        return await evaluated;
      } catch (firstErr) {
        if (!(firstErr instanceof SyntaxError)) {
          throw firstErr;
        }

        try {
          return await (0, eval)(code);
        } catch (secondErr) {
          if (!(secondErr instanceof SyntaxError)) {
            throw secondErr;
          }
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction('arg', code);
          return await fn(passedArg);
        }
      }
    },
    script,
    arg,
  );
}

async function evaluatePuppeteerScript(
  script: string,
  execContext: PuppeteerExecContext,
): Promise<unknown> {
  try {
    const evaluated = (0, eval)(`(${script})`);
    if (typeof evaluated === 'function') {
      return await evaluated(execContext);
    }
    return await evaluated;
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      'ctx',
      'const { page, browser, context, env, origin, url, arg, settle } = ctx;\n' + script,
    );
    return await fn(execContext);
  }
}

/**
 * Opens an isolated browser context in the active e-Builder session, navigates to the target
 * e-Builder page, optionally runs a DOM or Puppeteer script, and returns the result + updated cookies.
 */
export async function executeInSession(
  options: ExecuteInSessionOptions,
): Promise<ExecuteInSessionResult> {
  const {
    env,
    cookies,
    browser,
    headless = true,
    url,
    waitForSelector,
    script,
    mode = 'dom',
    arg,
    screenshotPath,
    blockAssets,
  } = options;

  const origin = `https://${env}.${baseurl}`;
  const targetUrl = resolveSessionUrl(env, url);
  const browserInstance =
    browser ||
    (await BrowserManager.getInstance().getBrowser(
      headless,
      headless ? ['--window-size=1440,900'] : undefined,
    ));

  const context = await browserInstance.createBrowserContext();
  let page: puppeteer.Page | null = null;

  try {
    await context.setCookie(...cookies);
    page = await context.newPage();

    const shouldBlockAssets = blockAssets ?? !screenshotPath;
    await optimizePageForAutomation(page, { blockAssets: shouldBlockAssets });

    if (typeof page.on === 'function') {
      page.on('dialog', async (dialog) => {
        try {
          await dialog.dismiss();
        } catch {}
      });
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForEBuilderPageToSettle(page);

    if (waitForSelector) {
      await waitForSelectorInPageOrFrame(page, waitForSelector);
    }

    let result: unknown = null;
    if (script && script.trim().length > 0) {
      if (mode === 'puppeteer') {
        result = await evaluatePuppeteerScript(script, {
          page,
          browser: browserInstance,
          context,
          env,
          origin,
          url: typeof page.url === 'function' ? page.url() : targetUrl,
          arg,
          settle: () => waitForEBuilderPageToSettle(page!),
        });
      } else {
        result = await evaluateDomScript(page, script, arg);
      }
    }

    const finalUrl = typeof page.url === 'function' ? page.url() : targetUrl;
    let title = '';
    let frameUrl: string | null = null;

    if (typeof page.title === 'function') {
      try {
        title = await page.title();
      } catch {}
    }

    if (typeof page.evaluate === 'function') {
      try {
        const meta = await page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>(
            'iframe#contentFrame, iframe[name="contentFrame"]',
          );
          let innerHref: string | null = null;
          try {
            innerHref = iframe?.contentWindow?.location?.href || iframe?.src || null;
          } catch {
            innerHref = iframe?.src || null;
          }
          return {
            docTitle: document.title || '',
            innerHref,
          };
        });
        if (!title && meta?.docTitle) {
          title = meta.docTitle;
        }
        if (meta?.innerHref) {
          frameUrl = meta.innerHref;
        }
      } catch {}
    }

    if (!script || script.trim().length === 0) {
      result = {
        url: finalUrl,
        title,
        frameUrl,
      };
    }

    if (screenshotPath && typeof page.screenshot === 'function') {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    const updatedCookies =
      typeof context.cookies === 'function' ? await context.cookies() : cookies;

    return {
      url: finalUrl,
      title,
      frameUrl,
      result,
      cookies: updatedCookies,
      screenshotPath: screenshotPath ?? null,
    };
  } finally {
    if (page && typeof page.close === 'function') {
      await page.close().catch(() => {});
    }
    if (typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}
