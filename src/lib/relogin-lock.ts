import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cross-process lock so only one eb process performs an automatic re-login at a time.
 * Concurrent logins each consume a TOTP code (codes are single-use within their window),
 * so parallel re-logins lock each other — and the user — out.
 */
export function getReloginLockPath(): string {
  return process.env['EB_RELOGIN_LOCK_FILE'] || path.join(os.homedir(), '.eb-cli', 'relogin.lock');
}

const STALE_MS = 5 * 60_000;

function isStale(file: string): boolean {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: number };
    if (Date.now() - at > STALE_MS) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e: any) {
      return e?.code !== 'EPERM';
    }
  } catch {
    // Unreadable/partial file: treat as stale only if old.
    try {
      return Date.now() - fs.statSync(file).mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  }
}

/** Acquires the lock (waiting up to `timeoutMs`) and returns a release function. */
export async function acquireReloginLock(timeoutMs: number = 180_000): Promise<() => void> {
  const file = getReloginLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (owner.pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (isStale(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for another eb process to finish logging in');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
