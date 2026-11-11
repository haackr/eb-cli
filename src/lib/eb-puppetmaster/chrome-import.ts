/**
 * Reads the e-Builder cookies out of the user's *running* Google Chrome.
 *
 * Chrome 136+ ignores `--remote-debugging-port` on the default profile, and copying the profile
 * off disk misses session-only cookies (and hits macOS cookie encryption). Since Chrome 144 the
 * user can instead allow remote debugging of their live browser at
 * chrome://inspect/#remote-debugging; Chrome then writes `DevToolsActivePort` (port + browser
 * WebSocket path) into its user data dir and asks the user to approve each connection.
 *
 * We connect without attaching to any tab, read cookies with the browser-level
 * `Storage.getCookies` (in-memory, decrypted, including session cookies), keep only
 * e-Builder's, and disconnect. The user's browser and tabs are never touched or closed.
 */
import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { Environment, baseurl, envMap } from './index.js';
import { cookieMatchesHost } from './session-identity.js';

export const REMOTE_DEBUGGING_SETTINGS_URL = 'chrome://inspect/#remote-debugging';

export class ChromeImportError extends Error {
  constructor(
    message: string,
    readonly code: 'no_data_dir' | 'not_enabled' | 'not_running' | 'declined' | 'timeout',
  ) {
    super(message);
    this.name = 'ChromeImportError';
  }
}

export function getDefaultChromeDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(configHome, 'google-chrome');
}

/** Parses `DevToolsActivePort` ("<port>\n/devtools/browser/<id>"). */
export function parseDevToolsActivePort(content: string): string | undefined {
  const [rawPort, rawPath] = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!rawPath || !rawPath.startsWith('/devtools/browser/')) return undefined;
  return `ws://127.0.0.1:${port}${rawPath}`;
}

export function readDevToolsEndpoint(chromeDataDir: string): string | undefined {
  try {
    return parseDevToolsActivePort(
      fs.readFileSync(path.join(chromeDataDir, 'DevToolsActivePort'), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

type CookieLike = { name: string; value: string; domain?: string | undefined };

/** Cookies that e-Builder (any environment) would receive; drops everything else in the jar. */
export function filterEBuilderCookies<T extends CookieLike>(cookies: T[]): T[] {
  return cookies.filter((c) => {
    const d = (c.domain ?? '').toLowerCase().replace(/^\./, '');
    return d === baseurl || d.endsWith(`.${baseurl}`);
  });
}

/** Cookies sent to this environment's app or gateway host. */
export function cookiesForEnvironment<T extends CookieLike>(env: Environment, cookies: T[]): T[] {
  const appHost = `${env}.${baseurl}`;
  const gatewayHost = `gateway.${appHost}`;
  return cookies.filter((c) => cookieMatchesHost(c, appHost) || cookieMatchesHost(c, gatewayHost));
}

/**
 * Environments with an authenticated-looking session: an auth cookie (`.ASPXAUTH` or `JWT`)
 * scoped to that environment's app host itself (not a parent domain like `.e-builder.net`).
 */
export function detectEnvironments(cookies: CookieLike[]): Environment[] {
  const found: Environment[] = [];
  for (const sub of Object.values(envMap)) {
    const appHost = `${sub}.${baseurl}`;
    const hasAuth = cookies.some((c) => {
      const d = (c.domain ?? '').toLowerCase().replace(/^\./, '');
      return d === appHost && (c.name === '.ASPXAUTH' || c.name === 'JWT');
    });
    if (hasAuth) found.push(sub as Environment);
  }
  return found;
}

function isChromeRunning(): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH']]
      : ['pgrep', ['-x', process.platform === 'darwin' ? 'Google Chrome' : 'chrome']];
  return new Promise((resolve) => {
    execFile(cmd as string, args as string[], (err, stdout) => {
      if (process.platform === 'win32') resolve(/chrome\.exe/i.test(String(stdout)));
      else resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

/** Best-effort: opens Chrome's remote-debugging settings page. */
export function openRemoteDebuggingSettings(): void {
  const url = REMOTE_DEBUGGING_SETTINGS_URL;
  if (process.platform === 'darwin') {
    execFile('open', ['-a', 'Google Chrome', url], () => {});
  } else if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', 'chrome', url], () => {});
  } else {
    execFile('google-chrome', [url], () => {});
  }
}

export type ReadChromeCookiesOptions = {
  chromeDataDir?: string | undefined;
  /** How long to wait for the user to enable remote debugging and approve the connection. */
  timeoutMs?: number | undefined;
  /** Called once if remote debugging is not enabled yet (e.g. to print instructions). */
  onNeedsSetup?: (() => void) | undefined;
  /** Called when a connection attempt is about to trigger Chrome's approval prompt. */
  onAwaitingApproval?: (() => void) | undefined;
  /** Injection points for tests. */
  connect?: ((endpoint: string) => Promise<puppeteer.Browser>) | undefined;
  isRunning?: (() => Promise<boolean>) | undefined;
  pollMs?: number | undefined;
};

const defaultConnect = (endpoint: string) =>
  puppeteer.connect({
    browserWSEndpoint: endpoint,
    defaultViewport: null,
    // Attach to nothing: we only need browser-level Storage.getCookies.
    targetFilter: () => false,
    protocolTimeout: 30_000,
  });

function looksDeclined(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(403|401)\b|forbidden|rejected|declin|denied/i.test(msg);
}

/** Races `p` against a timer that is always cleared, so it never keeps the process alive. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMEOUT>((r) => {
        timer = setTimeout(() => r(TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const TIMEOUT = Symbol('timeout');

/**
 * Returns the e-Builder cookies from the user's running Chrome. Waits (up to `timeoutMs`) for
 * the user to enable remote debugging and approve the connection. Never closes Chrome.
 */
export async function readChromeCookies(
  options: ReadChromeCookiesOptions = {},
): Promise<puppeteer.Cookie[]> {
  const chromeDataDir = options.chromeDataDir ?? getDefaultChromeDataDir();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1_000;
  const connect = options.connect ?? defaultConnect;
  const isRunning = options.isRunning ?? isChromeRunning;
  const deadline = Date.now() + timeoutMs;

  if (!fs.existsSync(chromeDataDir)) {
    throw new ChromeImportError(
      `Google Chrome user data directory not found at: ${chromeDataDir}`,
      'no_data_dir',
    );
  }
  if (!(await isRunning())) {
    throw new ChromeImportError(
      'Google Chrome is not running. Open Chrome, sign in to e-Builder, then run this again.',
      'not_running',
    );
  }

  let setupShown = false;
  let lastError: unknown;
  let lastTried: string | undefined;
  while (Date.now() < deadline) {
    const endpoint = readDevToolsEndpoint(chromeDataDir);
    if (endpoint && endpoint !== lastTried) {
      lastTried = endpoint;
      options.onAwaitingApproval?.();
      let browser: puppeteer.Browser | undefined;
      try {
        const result = await withTimeout(connect(endpoint), Math.max(1, deadline - Date.now()));
        if (result === TIMEOUT) break;
        browser = result;
        return filterEBuilderCookies(await browser.cookies());
      } catch (err) {
        lastError = err;
        if (looksDeclined(err)) {
          throw new ChromeImportError(
            'Chrome declined the remote debugging connection. Run this again and click "Allow" in Chrome.',
            'declined',
          );
        }
        // Stale port file (remote debugging switched off, or Chrome restarted): wait for a new one.
      } finally {
        await browser?.disconnect().catch(() => {});
      }
    }
    if (!setupShown) {
      setupShown = true;
      options.onNeedsSetup?.();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new ChromeImportError(
    `Could not connect to Chrome. Enable remote debugging at ${REMOTE_DEBUGGING_SETTINGS_URL} (Chrome 144 or newer), approve the connection prompt, and try again.${
      lastError instanceof Error ? ` (${lastError.message})` : ''
    }`,
    lastTried ? 'timeout' : 'not_enabled',
  );
}
