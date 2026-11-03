import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Optional warm headless Chromium shared across `eb` invocations.
 *
 * Only callers that isolate their work in their own BrowserContext opt in (see
 * BrowserManager.getBrowser's `allowDaemon`), so cookies never leak between sessions or runs.
 *
 * EB_BROWSER_DAEMON controls client behavior:
 *   (unset)  reuse a running daemon if one exists, otherwise launch a local browser
 *   auto     start a daemon on first use if none is running
 *   off      never use a daemon
 */
export interface BrowserDaemonInfo {
  pid: number;
  browserPid?: number | undefined;
  wsEndpoint: string;
  headless: true;
  startedAt: string;
  idleTimeoutMs: number;
  cliVersion: string;
}

export const DEFAULT_DAEMON_IDLE_MS = 15 * 60_000;

export function getDaemonInfoPath(): string {
  return (
    process.env['EB_BROWSER_DAEMON_FILE'] ||
    path.join(os.homedir(), '.eb-cli', 'browser-daemon.json')
  );
}

export function getCliVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'package.json',
    );
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getDaemonMode(): 'default' | 'auto' | 'off' {
  const v = (process.env['EB_BROWSER_DAEMON'] || '').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'auto' || v === '1' || v === 'true') return 'auto';
  return 'default';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export function writeDaemonInfo(info: BrowserDaemonInfo): void {
  const file = getDaemonInfoPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // The endpoint grants full control of the browser: keep it private to the user.
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeDaemonInfo(onlyIfPid?: number): void {
  const file = getDaemonInfoPath();
  try {
    if (onlyIfPid !== undefined) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as BrowserDaemonInfo;
      if (current.pid !== onlyIfPid) return;
    }
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

/** Reads the daemon info file, removing it if the recorded process is gone. */
export function readDaemonInfo(): BrowserDaemonInfo | null {
  let info: BrowserDaemonInfo;
  try {
    info = JSON.parse(fs.readFileSync(getDaemonInfoPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!info?.wsEndpoint || !info.pid || !isProcessAlive(info.pid)) {
    removeDaemonInfo();
    return null;
  }
  return info;
}

/** Connects to a running, version-compatible daemon. Returns null on any failure. */
export async function connectToDaemon(): Promise<puppeteer.Browser | null> {
  const mode = getDaemonMode();
  if (mode === 'off') return null;

  let info = readDaemonInfo();
  if (!info && mode === 'auto') {
    info = await startDaemon().catch(() => null);
  }
  if (!info || info.cliVersion !== getCliVersion()) return null;

  try {
    return await puppeteer.connect({
      browserWSEndpoint: info.wsEndpoint,
      defaultViewport: { width: 800, height: 600 },
      protocolTimeout: 180_000,
    });
  } catch {
    return null;
  }
}

/**
 * Spawns the detached daemon process and waits for it to publish its endpoint.
 * Returns the existing daemon if one is already running.
 */
export async function startDaemon(
  idleTimeoutMs: number = DEFAULT_DAEMON_IDLE_MS,
  timeoutMs: number = 30_000,
): Promise<BrowserDaemonInfo> {
  const existing = readDaemonInfo();
  if (existing) return existing;

  const serverScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'browser-daemon-server.js',
  );
  const child = spawn(process.execPath, [serverScript, '--idle-ms', String(idleTimeoutMs)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, EB_BROWSER_DAEMON: 'off' },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    if (info && info.pid === child.pid) return info;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Browser daemon did not start (no endpoint published).');
}

/** Stops the running daemon. Returns false when none was running. */
export async function stopDaemon(timeoutMs: number = 10_000): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info) return false;
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(info.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGKILL');
    } catch {}
    if (info.browserPid) {
      try {
        process.kill(info.browserPid, 'SIGKILL');
      } catch {}
    }
  }
  removeDaemonInfo();
  return true;
}
