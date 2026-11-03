import { Args } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { getProcessInstance } from '../../lib/eb-puppetmaster/process-instance.js';
import { projectFlag, resolveInstanceId } from '../../lib/process-command-utils.js';

export default class ProcessView extends BaseSessionCommand {
  static override summary = 'Show a process instance: step, status, available actions, and fields';
  static override examples = [
    '<%= config.bin %> <%= command.id %> 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 --json',
    '<%= config.bin %> <%= command.id %> "MPA - 2" --project "RH - eB-CLI Test project" --json',
  ];
  static override enableJsonFlag = true;
  static override args = {
    instance: Args.string({
      description: 'InstanceID GUID, or instance name with --project',
      required: true,
    }),
  };
  static override flags = { ...BaseSessionCommand.baseFlags, project: projectFlag };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProcessView);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const details = await this.withSessionCookies(
        session.id,
        !flags['show-browser'],
        async (cookies) => {
          const instanceId = await resolveInstanceId(
            { env, cookies },
            args.instance,
            flags.project,
          );
          return await getProcessInstance({ env, cookies, instanceId });
        },
      );
      if (!this.jsonEnabled()) {
        this.log(`${details.title}  [${details.instanceId}]`);
        this.log(
          `Project: ${details.project ?? ''}  Step: ${details.currentStep ?? ''}  Status: ${details.status ?? ''}`,
        );
        this.log(`Subject: ${details.subject ?? ''}`);
        this.log(
          `Actions: ${details.actions.map((a) => a.name).join(', ') || '(none for you)'}${details.ownershipPending ? '  (ownership not accepted)' : ''}`,
        );
        for (const f of details.fields) {
          const v = Array.isArray(f.value) ? f.value.join('; ') : f.value;
          this.log(
            `  ${f.editable ? '✎' : ' '} ${f.required ? '*' : ' '}${f.label} [${f.type}]: ${v ?? ''}`,
          );
        }
      }
      return details;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
