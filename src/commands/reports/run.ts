import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { runReport, type RunReportResult } from '../../lib/eb-puppetmaster/report.js';

export default class ReportsRun extends BaseSessionCommand {
  static override description =
    'run an e-Builder report and return token-efficient tabular results or export CSV/JSON';
  static override examples = [
    '<%= config.bin %> <%= command.id %> 12345 --limit 25 --json',
    '<%= config.bin %> <%= command.id %> 12345 --format csv --output-file ./report.csv',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['reports:execute'];

  static override args = {
    report: Args.string({
      description: 'Report ID to execute',
      required: true,
    }),
  };

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    limit: Flags.integer({
      char: 'l',
      description: 'maximum number of rows to extract for token safety (default: 50)',
      default: 50,
    }),
    format: Flags.string({
      options: ['json', 'csv'],
      default: 'json',
      description: 'output format',
    }),
    'output-file': Flags.string({
      char: 'o',
      description: 'file path to save report output',
    }),
  };

  public async run(): Promise<RunReportResult | void> {
    const { args, flags } = await this.parse(ReportsRun);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const headless = !flags['show-browser'];
    const cookies = await this.getSessionCookies(session.id, headless);

    try {
      const result = await runReport({
        env,
        cookies,
        reportId: args.report,
        limit: flags.limit,
      });

      if (flags['output-file']) {
        const outPath = path.resolve(flags['output-file']);
        if (flags.format === 'csv') {
          const csvText = Papa.unparse({
            fields: result.headers,
            data: result.rows,
          });
          fs.writeFileSync(outPath, csvText, 'utf8');
        } else {
          fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
        }
      }

      if (this.jsonEnabled()) {
        return result;
      }

      if (flags.format === 'csv') {
        this.log(
          Papa.unparse({
            fields: result.headers,
            data: result.rows,
          }),
        );
      } else {
        this.log(JSON.stringify(result, null, 2));
      }
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
