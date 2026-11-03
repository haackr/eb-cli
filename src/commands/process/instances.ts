import { Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { listProcessInstances } from '../../lib/eb-puppetmaster/process-instance.js';
import { requiredProjectFlag } from '../../lib/process-command-utils.js';

export default class ProcessInstances extends BaseSessionCommand {
  static override summary = "List a project's open process instances";
  static override description =
    "Lists the instances on the project's Processes page (its default view: open instances) with step, status, and dates.";
  static override examples = [
    '<%= config.bin %> <%= command.id %> --project "RH - eB-CLI Test project" --json',
    '<%= config.bin %> <%= command.id %> --project "RH - eB-CLI Test project" --process MPA --search "asset" --json',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    project: requiredProjectFlag,
    process: Flags.string({
      description: 'Filter by process prefix (e.g. "MPA") or process type name',
    }),
    search: Flags.string({ description: 'Case-insensitive text filter over all columns' }),
  };

  public async run(): Promise<unknown> {
    const { flags } = await this.parse(ProcessInstances);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const result = await this.withSessionCookies(session.id, !flags['show-browser'], (cookies) =>
        listProcessInstances({
          env,
          cookies,
          project: flags.project,
          process: flags.process,
          search: flags.search,
        }),
      );
      if (!this.jsonEnabled()) {
        this.log(`${result.project.name}: ${result.instances.length} open instance(s)`);
        for (const i of result.instances) {
          this.log(
            `  ${i.name.padEnd(12)} ${String(i.step ?? '').padEnd(28)} ${String(i.status ?? '').padEnd(12)} ${i.subject ?? ''}  [${i.instanceId}]`,
          );
        }
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
