import { Args, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { startProcessInstance } from '../../lib/eb-puppetmaster/process-instance.js';
import {
  fieldFlags,
  parseFieldInputs,
  requiredProjectFlag,
} from '../../lib/process-command-utils.js';

export default class ProcessStart extends BaseSessionCommand {
  static override summary =
    'Start (initiate) a process in a project, filling in its start-form fields';
  static override description =
    'Fills the start form and clicks Submit (or Save Draft with --draft). Fields are matched by label. Some workflows generate the subject automatically; --subject is only accepted when the form has a subject box. Nothing is submitted if any field cannot be set.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> "Weather Demo" --project "RH - eB-CLI Test project" --subject "Site visit" -F "Weather_Conditions=Sunny" --json',
    '<%= config.bin %> <%= command.id %> MPA -P "RH - eB-CLI Test project" -F "RFI Subject=Door hardware" -F "Is There a Potential Cost Impact?=No" --json',
  ];
  static override enableJsonFlag = true;
  static override args = {
    process: Args.string({
      description: 'Process name, prefix (e.g. "MPA"), or ProcessID',
      required: true,
    }),
  };
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    project: requiredProjectFlag,
    subject: Flags.string({
      description: 'Instance subject (when the workflow allows a manual subject)',
    }),
    ...fieldFlags,
    draft: Flags.boolean({ description: 'Save as a draft instead of submitting', default: false }),
    'dry-run': Flags.boolean({
      description: 'Fill the form and report what would be set, without submitting',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProcessStart);
    let fields;
    try {
      fields = parseFieldInputs(flags.field, flags.fields);
    } catch (e: any) {
      this.error(e.message);
    }
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const result = await this.withSessionCookies(session.id, !flags['show-browser'], (cookies) =>
        startProcessInstance({
          env,
          cookies,
          project: flags.project,
          process: args.process,
          subject: flags.subject,
          fields,
          draft: flags.draft,
          dryRun: flags['dry-run'],
        }),
      );
      if (!this.jsonEnabled()) {
        this.log(
          flags['dry-run']
            ? `Dry run: ${result.fields.length} field(s) would be set on ${result.process.name}`
            : `${result.draft ? 'Saved draft' : 'Started'} ${result.instance?.name ?? result.process.name} in ${result.project.name}${result.instance ? ` [${result.instance.instanceId}]` : ''}`,
        );
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
