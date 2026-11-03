import { Args, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { setProcessInstanceFields } from '../../lib/eb-puppetmaster/process-instance.js';
import {
  fieldFlags,
  parseFieldInputs,
  projectFlag,
  resolveInstanceId,
} from '../../lib/process-command-utils.js';

export default class ProcessSet extends BaseSessionCommand {
  static override summary = 'Set fields on a process instance and save';
  static override description =
    'Only fields editable at the current step can be set. Nothing is saved if any field cannot be set. If the step is assigned to a role whose ownership has not been accepted, e-Builder discards edits; pass --accept-ownership to accept it first.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 -F "Drawing Number=A-101" --json',
    '<%= config.bin %> <%= command.id %> "MPA - 2" -P "RH - eB-CLI Test project" --fields \'{"Discipline":"Civil"}\' --accept-ownership --json',
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
    ...fieldFlags,
    'accept-ownership': Flags.boolean({
      description: "Accept ownership of the step first if it hasn't been accepted",
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Set the values in the form without saving',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProcessSet);
    let fields;
    try {
      fields = parseFieldInputs(flags.field, flags.fields);
    } catch (e: any) {
      this.error(e.message);
    }
    if (!Object.keys(fields).length) this.error('Pass at least one --field or --fields');
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
          return await setProcessInstanceFields({
            env,
            cookies,
            instanceId,
            fields,
            dryRun: flags['dry-run'],
            acceptOwnership: flags['accept-ownership'],
          });
        },
      );
      if (!this.jsonEnabled()) {
        this.log(
          `${result.saved ? 'Saved' : 'Dry run:'} ${result.fields.length} field(s) on ${result.instance.name}${result.acceptedOwnership ? ' (ownership accepted)' : ''}`,
        );
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
