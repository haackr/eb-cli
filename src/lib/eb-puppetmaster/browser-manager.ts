import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

export type Cookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: any;
};

export function normalizeCookies(cookies: any[]): Cookie[] {
  if (!Array.isArray(cookies)) return [];
  return cookies.map((c) => {
    const cookie: Cookie = {
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
    };
    if (typeof c.expires === 'number' && c.expires > 0) {
      cookie.expires = c.expires;
    }
    if (c.sameSite) {
      const ss = String(c.sameSite).toLowerCase();
      if (ss === 'strict') cookie.sameSite = 'Strict';
      else if (ss === 'lax') cookie.sameSite = 'Lax';
      else if (ss === 'none') cookie.sameSite = 'None';
    }
    return cookie;
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function installPlaywrightChromium(withDeps: boolean = false): void {
  const args = ['playwright', 'install', 'chromium'];
  if (withDeps) {
    args.push('--with-deps');
  }

  execFileSync('npx', args, {
    stdio: 'inherit',
  });
}

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: Browser | null = null;
  private currentHeadless: boolean | null = null;

  constructor() {
    const cleanup = async () => {
      await this.closeBrowser();
    };

    process.on('exit', () => {
      if (this.browser) {
        this.browser.close().catch(console.error);
      }
    });

    process.on('SIGINT', async () => {
      await cleanup();
      process.exit();
    });

    process.on('SIGTERM', async () => {
      await cleanup();
      process.exit();
    });

    process.on('uncaughtException', async (err) => {
      console.error('Uncaught Exception:', err);
      await cleanup();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      await cleanup();
      process.exit(1);
    });
  }

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  async getBrowser(
    headless: boolean = true,
    args?: string[],
    useUserChrome: boolean = false,
  ): Promise<Browser> {
    let needsRelaunch = false;
    if (!this.browser || !this.browser.isConnected()) {
      needsRelaunch = true;
    } else if (this.currentHeadless !== headless) {
      needsRelaunch = true;
    } else {
      try {
        await this.browser.version();
      } catch {
        needsRelaunch = true;
      }
    }

    if (needsRelaunch) {
      if (this.browser) {
        try {
          if (this.browser.isConnected()) {
            await this.browser.close();
          }
        } catch {
          // Ignore errors during close
        }
        this.browser = null;
      }
      this.currentHeadless = headless;
      const requiredArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
      const launchArgs = [...new Set([...(args ?? []), ...requiredArgs])];

      try {
        if (useUserChrome) {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-sso-login-browser'));
          const userChromeArgs = [
            `--user-data-dir=${tmpDir}`,
            '--new-window',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
          ];
          const newLaunchArgs = [...new Set([...launchArgs, ...userChromeArgs])];
          this.browser = await chromium.launch({
            headless,
            channel: 'chrome',
            ignoreDefaultArgs: ['--enable-automation'],
            args: newLaunchArgs,
          });
          this.browser.on('disconnected', () => {
            try {
              if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              }
            } catch {}
          });
        } else {
          this.browser = await chromium.launch({
            headless,
            args: launchArgs,
          });
        }
      } catch (launchError) {
        console.log('Playwright failed to launch browser. Attempting to install Chromium...');
        try {
          installPlaywrightChromium();
          this.browser = await chromium.launch({
            headless,
            args: launchArgs,
          });
        } catch {
          try {
            console.log('Retrying with system Chrome / dependencies...');
            installPlaywrightChromium(true);
            this.browser = await chromium.launch({
              headless,
              args: launchArgs,
            });
          } catch (dependencyRetryError) {
            throw new Error(
              `Failed to launch browser with Playwright. Initial error: ${getErrorMessage(
                launchError,
              )}. Retry error: ${getErrorMessage(dependencyRetryError)}`,
            );
          }
        }
      }
    }

    if (!this.browser) {
      throw new Error('Failed to initialize browser');
    }

    return this.browser;
  }

  async getDefaultContext(browser: Browser): Promise<BrowserContext> {
    const existing = browser.contexts();
    if (existing.length > 0 && existing[0]) {
      return existing[0];
    }
    return await browser.newContext();
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.currentHeadless = null;
    }
  }
}

/**
 * Configures a Playwright page for maximum performance during automated runs.
 * Intercepts and blocks non-critical resources (images, fonts, stylesheets, trackers)
 * and configures generous operation timeouts.
 */
export async function optimizePageForAutomation(
  page: Page,
  options: { blockAssets?: boolean } = { blockAssets: true },
): Promise<void> {
  if (!page) return;
  if (typeof page.setDefaultNavigationTimeout === 'function') {
    page.setDefaultNavigationTimeout(90_000);
  }
  if (typeof page.setDefaultTimeout === 'function') {
    page.setDefaultTimeout(90_000);
  }

  if (options.blockAssets && typeof page.route === 'function') {
    try {
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        const url = route.request().url().toLowerCase();
        if (
          ['image', 'media', 'font'].includes(resourceType) ||
          url.includes('google-analytics') ||
          url.includes('googletagmanager') ||
          url.includes('pendo.io') ||
          url.includes('walkme') ||
          url.includes('doubleclick')
        ) {
          route.abort().catch(() => {});
        } else {
          route.continue().catch(() => {});
        }
      });
    } catch {
      // Ignore if route interception already set or in mock context
    }
  }
}
