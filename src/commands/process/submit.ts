import { Args } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { submitProcessDraft } from '../../lib/eb-puppetmaster/process-instance.js';
import { fieldFlags, parseFieldInputs } from '../../lib/process-command-utils.js';

export default class ProcessSubmit extends BaseSessionCommand {
  static override summary = 'Submit a draft process instance (optionally setting fields first)';
  static override examples = [
    '<%= config.bin %> <%= command.id %> fcc61467-0ea8-4dd4-89d8-cdee6853f85d -F "Weather_Conditions=Clear" --json',
  ];
  static override enableJsonFlag = true;
  static override args = {
    instance: Args.string({
      description: 'Draft InstanceID (returned by `eb process start --draft`)',
      required: true,
    }),
  };
  static override flags = { ...BaseSessionCommand.baseFlags, ...fieldFlags };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProcessSubmit);
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
        submitProcessDraft({ env, cookies, instanceId: args.instance, fields }),
      );
      if (!this.jsonEnabled()) {
        this.log(
          `Submitted ${result.instance.name}: now at "${result.instance.currentStep}" (${result.instance.status})`,
        );
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
