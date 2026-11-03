import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BrowserManager,
  connectToDaemon,
  readDaemonInfo,
  startDaemon,
  stopDaemon,
  writeDaemonInfo,
  getCliVersion,
} from '../../lib/eb-puppetmaster/index.js';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Browser daemon (src/lib/eb-puppetmaster/browser-daemon.ts)', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-daemon-test-'));
    process.env['EB_BROWSER_DAEMON_FILE'] = path.join(tmpDir, 'browser-daemon.json');
    delete process.env['EB_BROWSER_DAEMON'];
  });

  afterEach(async () => {
    await BrowserManager.getInstance().closeBrowser();
    await stopDaemon();
  });

  after(() => {
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes a stale info file whose process is gone', () => {
    writeDaemonInfo({
      pid: 999_999,
      wsEndpoint: 'ws://127.0.0.1:1/devtools/browser/x',
      headless: true,
      startedAt: new Date().toISOString(),
      idleTimeoutMs: 1000,
      cliVersion: getCliVersion(),
    });
    assert.strictEqual(readDaemonInfo(), null);
    assert.strictEqual(fs.existsSync(process.env['EB_BROWSER_DAEMON_FILE']!), false);
  });

  it('is only used by opt-in callers, and closeBrowser() just disconnects', async () => {
    const info = await startDaemon(60_000);
    assert.ok(isAlive(info.pid));
    assert.strictEqual(
      (fs.statSync(process.env['EB_BROWSER_DAEMON_FILE']!).mode & 0o777).toString(8),
      '600',
    );

    const manager = BrowserManager.getInstance();
    const shared = await manager.getBrowser(true, undefined, false, { allowDaemon: true });
    assert.strictEqual(manager.isUsingDaemon(), true);
    assert.strictEqual(shared.wsEndpoint(), info.wsEndpoint);

    // A caller that did not opt in must get its own browser.
    const local = await manager.getBrowser(true);
    assert.strictEqual(manager.isUsingDaemon(), false);
    assert.notStrictEqual(local.wsEndpoint(), info.wsEndpoint);
    await manager.closeBrowser();

    await manager.getBrowser(true, undefined, false, { allowDaemon: true });
    await manager.closeBrowser();
    assert.ok(isAlive(info.pid), 'daemon must survive client closeBrowser()');
    assert.ok(readDaemonInfo());

    assert.strictEqual(await stopDaemon(), true);
    assert.strictEqual(isAlive(info.pid), false);
    assert.strictEqual(readDaemonInfo(), null);
  });

  it('ignores the daemon when disabled or version-mismatched', async () => {
    const info = await startDaemon(60_000);
    process.env['EB_BROWSER_DAEMON'] = 'off';
    assert.strictEqual(await connectToDaemon(), null);
    delete process.env['EB_BROWSER_DAEMON'];

    writeDaemonInfo({ ...info, cliVersion: 'other-version' });
    assert.strictEqual(await connectToDaemon(), null);
  });

  it('shuts itself down after the idle timeout', async () => {
    const info = await startDaemon(1_500);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isAlive(info.pid)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(isAlive(info.pid), false);
    assert.strictEqual(readDaemonInfo(), null);
  });
});
