import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { exportReportConfig, type ReportConfig } from '../../lib/eb-puppetmaster/report.js';

export default class ReportsExportConfig extends BaseSessionCommand {
  static override description =
    'export portable configuration AST of an e-Builder report for inspection or cross-account replication';
  static override examples = [
    '<%= config.bin %> <%= command.id %> 12345 --json',
    '<%= config.bin %> <%= command.id %> 12345 --output-file ./report-config.json',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['reports:export'];

  static override args = {
    report: Args.string({
      description: 'Report ID to export configuration from',
      required: true,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'output-file': Flags.string({
      char: 'o',
      description: 'file path to save report configuration JSON',
    }),
  };

  public async run(): Promise<ReportConfig | void> {
    const { args, flags } = await this.parse(ReportsExportConfig);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const headless = !flags['show-browser'];
    const cookies = await this.getSessionCookies(session.id, headless);

    try {
      const config = await exportReportConfig({
        env,
        cookies,
        reportId: args.report,
      });

      if (flags['output-file']) {
        const outPath = path.resolve(flags['output-file']);
        fs.writeFileSync(outPath, JSON.stringify(config, null, 2), 'utf8');
      }

      if (this.jsonEnabled()) {
        return config;
      }

      this.log(JSON.stringify(config, null, 2));
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
