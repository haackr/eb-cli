import { Command, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';

export default class DaemonStart extends Command {
  static override summary = 'Start a warm headless browser shared by eb commands';
  static override description =
    'Starts a detached headless Chromium that `eb session exec`, `eb session test`, page inspection, and report/process-schema commands reuse instead of launching a browser per invocation. Every command still runs in its own isolated browser context. The daemon exits after the idle timeout. Set EB_BROWSER_DAEMON=auto to start it automatically, or EB_BROWSER_DAEMON=off to never use it.';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --idle-minutes 60 --json',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    'idle-minutes': Flags.integer({
      description: 'Shut down after this many minutes without activity',
      default: 15,
      min: 1,
    }),
  };

  public async run(): Promise<unknown> {
    const { flags } = await this.parse(DaemonStart);
    const existing = eb.readDaemonInfo();
    const info = existing ?? (await eb.startDaemon(flags['idle-minutes'] * 60_000));
    const result = { running: true, alreadyRunning: Boolean(existing), ...redact(info) };
    if (!this.jsonEnabled()) {
      this.log(
        existing
          ? `Browser daemon already running (pid ${info.pid}).`
          : `Browser daemon started (pid ${info.pid}, idle timeout ${flags['idle-minutes']}m).`,
      );
    }
    return result;
  }
}

export function redact(info: eb.BrowserDaemonInfo) {
  const { wsEndpoint: _ws, ...rest } = info;
  return rest;
}
