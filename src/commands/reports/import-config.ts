import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { assertReportConfig, createReportFromConfig } from '../../lib/eb-puppetmaster/report.js';

export default class ReportsImportConfig extends BaseSessionCommand {
  static override description =
    'create a new e-Builder report from a portable JSON report configuration file';
  static override examples = [
    '<%= config.bin %> <%= command.id %> ./my-report.json --json',
    '<%= config.bin %> <%= command.id %> ./my-report.json --name "New Custom Report"',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['reports:import'];

  static override args = {
    file: Args.string({
      description: 'Path to the report configuration JSON file',
      required: true,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    name: Flags.string({
      char: 'n',
      description: 'Optional name override for the imported report',
    }),
    folder: Flags.string({
      description: "Report folder to save into (overrides the config's folder)",
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ReportsImportConfig);

    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
      this.error(`Report configuration file not found: ${filePath}`);
    }

    const config: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (flags.name && config && typeof config === 'object') {
      (config as { name?: string }).name = flags.name;
    }
    if (flags.folder && config && typeof config === 'object') {
      (config as { folder?: string }).folder = flags.folder;
    }
    try {
      assertReportConfig(config);
    } catch (err: any) {
      this.error(err.message);
    }

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const headless = !flags['show-browser'];
    try {
      const result = await this.withSessionCookies(session.id, headless, (cookies) =>
        createReportFromConfig({
          env,
          cookies,
          config,
        }),
      );

      const payload = {
        success: result.success,
        reportName: config.name,
        reportId: result.reportId,
        warnings: [...(config.warnings ?? []), ...result.warnings],
        session: {
          id: session.id,
          username: session.username,
          environment: session.environment,
          account: session.account,
        },
        url: result.url,
      };

      if (this.jsonEnabled()) {
        return payload;
      }

      this.log(`Successfully imported report "${config.name}"!`);
      this.log(JSON.stringify(payload, null, 2));
      return payload;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
