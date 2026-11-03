import { Command } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { redact } from './start.js';

export default class DaemonStatus extends Command {
  static override summary = 'Show whether the warm headless browser daemon is running';
  static override examples = ['<%= config.bin %> <%= command.id %> --json'];
  static override enableJsonFlag = true;

  public async run(): Promise<unknown> {
    await this.parse(DaemonStatus);
    const info = eb.readDaemonInfo();
    const mode = eb.getDaemonMode();
    if (!info) {
      if (!this.jsonEnabled()) this.log(`Browser daemon is not running (mode: ${mode}).`);
      return { running: false, mode };
    }
    const compatible = info.cliVersion === eb.getCliVersion();
    const uptimeSeconds = Math.round((Date.now() - Date.parse(info.startedAt)) / 1000);
    if (!this.jsonEnabled()) {
      this.log(
        `Browser daemon running (pid ${info.pid}, up ${uptimeSeconds}s, idle timeout ${Math.round(
          info.idleTimeoutMs / 60_000,
        )}m, mode: ${mode})${compatible ? '' : ` — version ${info.cliVersion} differs from this CLI; it will not be used. Run 'eb daemon stop'.`}`,
      );
    }
    return { running: true, compatible, mode, uptimeSeconds, ...redact(info) };
  }
}
