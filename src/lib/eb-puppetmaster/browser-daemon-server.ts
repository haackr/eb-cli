/**
 * Entry point for the detached warm-browser daemon (spawned by startDaemon()).
 * Launches headless Chromium, publishes its WebSocket endpoint, and exits after the browser
 * has had no open isolated contexts or target activity for the idle timeout.
 */
import { BrowserManager } from './browser-manager.js';
import {
  DEFAULT_DAEMON_IDLE_MS,
  getCliVersion,
  removeDaemonInfo,
  writeDaemonInfo,
} from './browser-daemon.js';

function parseIdleMs(argv: string[]): number {
  const idx = argv.indexOf('--idle-ms');
  const value = idx >= 0 ? Number(argv[idx + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAEMON_IDLE_MS;
}

async function main(): Promise<void> {
  const idleTimeoutMs = parseIdleMs(process.argv);
  const browser = await BrowserManager.getInstance().getBrowser(true, ['--window-size=1440,900']);

  writeDaemonInfo({
    pid: process.pid,
    browserPid: browser.process()?.pid,
    wsEndpoint: browser.wsEndpoint(),
    headless: true,
    startedAt: new Date().toISOString(),
    idleTimeoutMs,
    cliVersion: getCliVersion(),
  });

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  browser.on('targetcreated', touch);
  browser.on('targetchanged', touch);
  browser.on('targetdestroyed', touch);

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeDaemonInfo(process.pid);
    await BrowserManager.getInstance()
      .closeBrowser()
      .catch(() => {});
    process.exit(code);
  };

  process.on('exit', () => removeDaemonInfo(process.pid));
  browser.on('disconnected', () => void shutdown(0));

  const interval = setInterval(
    () => {
      // Clients always work inside their own BrowserContext; any open one means "busy".
      if (browser.browserContexts().length > 1) touch();
      if (Date.now() - lastActivity > idleTimeoutMs) {
        clearInterval(interval);
        void shutdown(0);
      }
    },
    Math.min(10_000, Math.max(250, Math.floor(idleTimeoutMs / 4))),
  );
}

main().catch(() => {
  removeDaemonInfo(process.pid);
  process.exit(1);
});
