import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function getPuppeteerCliPath(): string {
  const puppeteerPackageJsonPath = require.resolve('puppeteer/package.json');
  const puppeteerDir = dirname(puppeteerPackageJsonPath);

  try {
    const pkg = JSON.parse(fs.readFileSync(puppeteerPackageJsonPath, 'utf8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.puppeteer;
    if (binRel) {
      const candidate = join(puppeteerDir, binRel);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // fallback to candidate list below
  }

  const cliCandidates = [
    join(puppeteerDir, 'lib', 'puppeteer', 'node', 'cli.js'),
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

function get1PasswordExtensionDir(): string | undefined {
  let chromeDataDir: string;
  if (process.platform === 'darwin') {
    chromeDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (process.platform === 'win32') {
    chromeDataDir = path.join(
      process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data',
    );
  } else {
    chromeDataDir = path.join(
      process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'),
      'google-chrome',
    );
  }

  const extBase = path.join(
    chromeDataDir,
    'Default',
    'Extensions',
    'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
  );
  if (fs.existsSync(extBase)) {
    const versions = fs.readdirSync(extBase).filter((f) => !f.startsWith('.'));
    if (versions.length > 0) {
      const latest = versions.sort().reverse()[0]!;
      return path.join(extBase, latest);
    }
  }
  return undefined;
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
    useUserChrome: boolean = false,
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

      const extDir = !headless ? get1PasswordExtensionDir() : undefined;
      const ignoreDefaults: string[] = ['--enable-automation'];
      if (extDir) {
        launchArgs.push(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
        ignoreDefaults.push('--disable-extensions');
      }

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
          this.browser = await puppeteer.launch({
            headless,
            channel: 'chrome',
            ignoreDefaultArgs: ignoreDefaults,
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
          const launchOpts: puppeteer.LaunchOptions = {
            headless,
            args: launchArgs,
          };
          if (extDir) {
            launchOpts.channel = 'chrome';
            launchOpts.ignoreDefaultArgs = ignoreDefaults;
          }
          this.browser = await puppeteer.launch(launchOpts);
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

/**
 * Configures a Puppeteer page for maximum performance during automated runs.
 * Intercepts and blocks non-critical resources (images, fonts, stylesheets, trackers)
 * and configures generous operation timeouts.
 */
export async function optimizePageForAutomation(
  page: puppeteer.Page,
  options: { blockAssets?: boolean } = { blockAssets: true },
): Promise<void> {
  if (!page) return;
  if (typeof page.setDefaultNavigationTimeout === 'function') {
    page.setDefaultNavigationTimeout(90_000);
  }
  if (typeof page.setDefaultTimeout === 'function') {
    page.setDefaultTimeout(90_000);
  }

  if (options.blockAssets && typeof page.setRequestInterception === 'function') {
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = typeof req.resourceType === 'function' ? req.resourceType() : '';
        const url = (typeof req.url === 'function' ? req.url() : '').toLowerCase();
        if (
          ['image', 'media'].includes(resourceType) ||
          url.includes('google-analytics') ||
          url.includes('googletagmanager') ||
          url.includes('pendo.io') ||
          url.includes('walkme') ||
          url.includes('doubleclick')
        ) {
          if (typeof req.abort === 'function') {
            req.abort().catch(() => {});
          }
        } else {
          if (typeof req.continue === 'function') {
            req.continue().catch(() => {});
          }
        }
      });
    } catch {
      // Ignore if request interception is already active or in mock context
    }
  }
}
