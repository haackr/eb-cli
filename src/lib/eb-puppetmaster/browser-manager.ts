import puppeteer from 'puppeteer';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function getPuppeteerCliPath(): string {
  const puppeteerPackageJsonPath = require.resolve('puppeteer/package.json');
  const puppeteerDir = dirname(puppeteerPackageJsonPath);
  const cliCandidates = [
    join(puppeteerDir, 'lib', 'cjs', 'puppeteer', 'node', 'cli.js'),
    join(puppeteerDir, 'lib', 'esm', 'puppeteer', 'node', 'cli.js'),
  ];

  for (const candidate of cliCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Could not locate Puppeteer CLI script in installed package.');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function installChrome(includeDeps: boolean = false): void {
  const args = [getPuppeteerCliPath(), 'browsers', 'install', 'chrome'];

  if (includeDeps) {
    args.push('--install-deps');
  }

  execFileSync(process.execPath, args, {
    stdio: 'inherit',
  });
}

function shouldInstallChromeDeps(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }

  const envValue = process.env['EB_PUPPETEER_INSTALL_DEPS']?.toLowerCase();
  if (envValue === '1' || envValue === 'true' || envValue === 'yes') {
    return true;
  }

  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function getChromeDependencyHint(): string {
  if (process.platform !== 'linux') {
    return '';
  }

  return ' If this Linux environment allows package installs, rerun with EB_PUPPETEER_INSTALL_DEPS=1 to let Puppeteer install Chrome system dependencies, or install the required libraries manually.';
}

export class BrowserManager {
  private static instance: BrowserManager;
  private browser: puppeteer.Browser | null = null;
  private currentHeadless: boolean | null = null;

  constructor() {
    // Register cleanup handlers for process shutdown
    const cleanup = async () => {
      await this.closeBrowser();
    };

    process.on('exit', () => {
      // Synchronous cleanup for exit
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
    useUserChrome?: boolean = false,
  ): Promise<puppeteer.Browser> {
    // Check if browser is truly connected by testing it
    let needsRelaunch = false;
    if (!this.browser || !this.browser.connected) {
      needsRelaunch = true;
    } else if (this.currentHeadless !== headless) {
      needsRelaunch = true;
    } else {
      // Additional check: try to get browser contexts to verify connection
      try {
        await this.browser.version();
      } catch {
        needsRelaunch = true;
      }
    }

    if (needsRelaunch) {
      // Close existing browser if it exists
      if (this.browser) {
        try {
          if (this.browser.connected) {
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
          const userChromeArgs = [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
          ];
          const newLaunchArgs = [...new Set(...launchArgs, ...userChromeArgs)];
          this.browser = await puppeteer.launch({
            headless,
            channel: 'chrome',
            ignoreDefaultArgs: ['--enable-automation'],
            args: newLaunchArgs,
          });
        } else {
          this.browser = await puppeteer.launch({
            headless,
            args: launchArgs,
          });
        }
      } catch (launchError) {
        console.log('Puppeteer failed to launch browser. Attempting to install Chrome...');
        installChrome();

        try {
          this.browser = await puppeteer.launch({
            headless,
            args: launchArgs,
          });
        } catch (retryError) {
          if (shouldInstallChromeDeps()) {
            console.log(
              'Chrome installed but the browser still failed to launch. Attempting to install Chrome system dependencies...',
            );
            installChrome(true);

            try {
              this.browser = await puppeteer.launch({
                headless,
                args: launchArgs,
              });
            } catch (dependencyRetryError) {
              throw new Error(
                `Failed to launch browser after installing Chrome dependencies. Initial error: ${getErrorMessage(launchError)}. Retry error: ${getErrorMessage(dependencyRetryError)}`,
              );
            }
          } else {
            throw new Error(
              `Failed to launch browser after installing Chrome. Initial error: ${getErrorMessage(launchError)}. Retry error: ${getErrorMessage(retryError)}.${getChromeDependencyHint()}`,
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

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.currentHeadless = null;
    }
  }
}
