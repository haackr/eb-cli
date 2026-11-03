import { Args } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { acceptProcessOwnership } from '../../lib/eb-puppetmaster/process-instance.js';
import { projectFlag, resolveInstanceId } from '../../lib/process-command-utils.js';

export default class ProcessAccept extends BaseSessionCommand {
  static override summary =
    "Accept ownership of an instance's current step (take responsibility for it)";
  static override examples = [
    '<%= config.bin %> <%= command.id %> "MPA - 2" -P "RH - eB-CLI Test project" --json',
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
    const { args, flags } = await this.parse(ProcessAccept);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const result = await this.withSessionCookies(
        session.id,
        !flags['show-browser'],
        async (cookies) => {
          const instanceId = await resolveInstanceId(
            { env, cookies },
            args.instance,
            flags.project,
          );
          return await acceptProcessOwnership({ env, cookies, instanceId });
        },
      );
      if (!this.jsonEnabled()) {
        this.log(
          result.accepted
            ? `Accepted ownership of ${result.instance.name} (${result.instance.currentStep})`
            : `Nothing to accept on ${result.instance.name}`,
        );
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
