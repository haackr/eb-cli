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

  async getBrowser(headless: boolean = true, args?: string[]): Promise<puppeteer.Browser> {
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
        this.browser = await puppeteer.launch({
          headless,
          args: launchArgs,
        });
      } catch {
        console.log(
          'Puppeteer failed to launch browser. Attempting to install Chrome dependencies...',
        );
        // Use the current Node runtime so this works in packaged installs without global npx.
        execFileSync(
          process.execPath,
          [getPuppeteerCliPath(), 'browsers', 'install', 'chrome', '--install-deps'],
          {
            stdio: 'inherit',
          },
        );
        // Retry launch
        try {
          this.browser = await puppeteer.launch({
            headless,
            args: launchArgs,
          });
        } catch (retryError) {
          throw new Error(`Failed to launch browser after installing dependencies: ${retryError}`);
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
