import { Args, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import {
  fetchProcessSchema,
  getCachedProcessSchema,
  type ProcessSchema,
} from '../../lib/eb-puppetmaster/process-schema.js';

export default class ProcessInspect extends BaseSessionCommand {
  static override description =
    'inspect and project compact, token-efficient schema of an e-Builder process (fields, workflow, layout matrix)';
  static override examples = [
    '<%= config.bin %> <%= command.id %> "Commitment Change Order" --json',
    '<%= config.bin %> <%= command.id %> "Invoice" --refresh --json',
    '<%= config.bin %> <%= command.id %> "Submittal" --compact',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['process:schema'];

  static override args = {
    process: Args.string({
      description: 'Name of the e-Builder Process Type (e.g. "Commitment Change Order")',
      required: true,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    cached: Flags.boolean({
      description: 'use locally cached schema from SQLite if available (default: true)',
      default: true,
      allowNo: true,
    }),
    refresh: Flags.boolean({
      description: 'force live refresh from e-Builder and update cache',
      default: false,
    }),
    compact: Flags.boolean({
      description: 'output ultra-compact field and step summary',
      default: false,
    }),
  };

  public async run(): Promise<ProcessSchema | void> {
    const { args, flags } = await this.parse(ProcessInspect);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const useCache = flags.cached && !flags.refresh;

    if (useCache) {
      const cached = getCachedProcessSchema(session.environment, session.account, args.process);
      if (cached) {
        if (this.jsonEnabled()) {
          return cached;
        }
        this.log(JSON.stringify(cached, null, 2));
        return;
      }
    }

    const headless = !flags['show-browser'];
    const cookies = await this.getSessionCookies(session.id, headless);

    try {
      const schema = await fetchProcessSchema({
        env,
        cookies,
        processName: args.process,
        account: session.account,
        useCache: false,
      });

      if (this.jsonEnabled()) {
        return schema;
      }

      this.log(JSON.stringify(schema, null, 2));
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
