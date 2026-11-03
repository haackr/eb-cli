import { Command } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';

export default class DaemonStop extends Command {
  static override summary = 'Stop the warm headless browser daemon';
  static override examples = ['<%= config.bin %> <%= command.id %>'];
  static override enableJsonFlag = true;

  public async run(): Promise<unknown> {
    await this.parse(DaemonStop);
    const stopped = await eb.stopDaemon();
    if (!this.jsonEnabled()) {
      this.log(stopped ? 'Browser daemon stopped.' : 'No browser daemon is running.');
    }
    return { stopped };
  }
}
