import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { listStartableProcesses } from '../../lib/eb-puppetmaster/process-instance.js';
import { requiredProjectFlag } from '../../lib/process-command-utils.js';

export default class ProcessStartable extends BaseSessionCommand {
  static override summary = 'List the processes you can start in a project';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --project "RH - eB-CLI Test project" --json',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    project: requiredProjectFlag,
  };

  public async run(): Promise<unknown> {
    const { flags } = await this.parse(ProcessStartable);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const headless = !flags['show-browser'];
    try {
      const result = await this.withSessionCookies(session.id, headless, (cookies) =>
        listStartableProcesses({ env, cookies, project: flags.project }),
      );
      if (!this.jsonEnabled()) {
        this.log(`${result.project.name}: ${result.processes.length} startable process(es)`);
        for (const p of result.processes) this.log(`  ${p.prefix.padEnd(8)} ${p.name}`);
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
