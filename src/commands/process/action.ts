import { Args, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { takeProcessAction } from '../../lib/eb-puppetmaster/process-instance.js';
import {
  fieldFlags,
  parseFieldInputs,
  projectFlag,
  resolveInstanceId,
} from '../../lib/process-command-utils.js';

export default class ProcessAction extends BaseSessionCommand {
  static override summary =
    'Take a workflow action on a process instance (e.g. Approve, Revise, Close)';
  static override description =
    "Optionally sets fields first, then takes the action and completes e-Builder's comment step. Actions that require a comment fail with a clear error unless --comment is given. Use `eb process view` to list the actions available to you.";
  static override examples = [
    '<%= config.bin %> <%= command.id %> 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 --action Close --json',
    '<%= config.bin %> <%= command.id %> "MPA - 2" -P "RH - eB-CLI Test project" --action Revise --comment "Please add the drawing number" --json',
  ];
  static override enableJsonFlag = true;
  static override args = {
    instance: Args.string({
      description: 'InstanceID GUID, or instance name with --project',
      required: true,
    }),
  };
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    project: projectFlag,
    action: Flags.string({
      char: 'a',
      description: 'Action name (case-insensitive) or action ID',
      required: true,
    }),
    comment: Flags.string({ char: 'c', description: 'Comment to record with the action' }),
    private: Flags.boolean({ description: 'Mark the comment private', default: false }),
    ...fieldFlags,
    'accept-ownership': Flags.boolean({
      description: 'Accept ownership of the step first when setting fields',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProcessAction);
    let fields;
    try {
      fields = parseFieldInputs(flags.field, flags.fields);
    } catch (e: any) {
      this.error(e.message);
    }
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
          return await takeProcessAction({
            env,
            cookies,
            instanceId,
            action: flags.action,
            comment: flags.comment,
            privateComment: flags.private,
            fields,
            acceptOwnership: flags['accept-ownership'],
          });
        },
      );
      if (!this.jsonEnabled()) {
        this.log(
          `${result.action.name} taken on ${result.after.name}: ${result.before.step} → ${result.after.currentStep} (${result.after.status})`,
        );
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
