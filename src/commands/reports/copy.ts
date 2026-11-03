import { Command, Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as db from '../../lib/db.js';
import { exportReportConfig, createReportFromConfig } from '../../lib/eb-puppetmaster/report.js';

export default class ReportsCopy extends Command {
  static override description =
    'copy a report configuration directly from one e-Builder account/session to another';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --from-session 1 --to-session 2 --report-id 12345 --json',
    '<%= config.bin %> <%= command.id %> --from-session 1 --to-session 2 --report-id 12345 --name "Cloned Cost Summary"',
  ];
  static override enableJsonFlag = true;

  static override flags = {
    'from-session': Flags.integer({
      description: 'Source session ID containing the report to copy',
      required: true,
    }),
    'to-session': Flags.integer({
      description: 'Target session ID where the report will be recreated',
      required: true,
    }),
    'report-id': Flags.string({
      description: 'Source report ID to copy',
      required: true,
    }),
    name: Flags.string({
      char: 'n',
      description: 'Optional new name for the recreated report in the target account',
    }),
    'show-browser': Flags.boolean({
      char: 's',
      description: 'Show browser window during copying',
      default: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { flags } = await this.parse(ReportsCopy);

    const fromSession = db.getSessionById(flags['from-session']);
    if (!fromSession) {
      this.error(`Source session with ID ${flags['from-session']} not found.`);
    }

    const toSession = db.getSessionById(flags['to-session']);
    if (!toSession) {
      this.error(`Target session with ID ${flags['to-session']} not found.`);
    }

    // Stored cookies: exportReportConfig / createReportFromConfig detect a login redirect on
    // their own navigation (SessionExpiredError), so no separate pre-flight page load is needed.
    const fromCookies = JSON.parse(fromSession.session_cookies || '[]');
    const toCookies = JSON.parse(toSession.session_cookies || '[]');

    const fromEnv = eb.getEnvironment(fromSession.environment);
    const toEnv = eb.getEnvironment(toSession.environment);

    try {
      // Step 1: Export config from source session
      const config = await exportReportConfig({
        env: fromEnv,
        cookies: fromCookies,
        reportId: flags['report-id'],
      });

      if (flags.name) {
        config.name = flags.name;
      }

      // Step 2: Create report in target session
      const result = await createReportFromConfig({
        env: toEnv,
        cookies: toCookies,
        config,
      });

      const payload = {
        success: result.success,
        reportName: config.name,
        reportType: `${config.reportType.text} / ${config.reportSubType.text}`,
        reportId: result.reportId,
        warnings: [...(config.warnings ?? []), ...result.warnings],
        fromSession: {
          id: fromSession.id,
          username: fromSession.username,
          environment: fromSession.environment,
          account: fromSession.account,
        },
        toSession: {
          id: toSession.id,
          username: toSession.username,
          environment: toSession.environment,
          account: toSession.account,
        },
        columnsCopied: config.columns.length,
        createdUrl: result.url,
      };

      if (this.jsonEnabled()) {
        return payload;
      }

      this.log(`Successfully copied report "${config.name}" to ${toSession.account}!`);
      this.log(JSON.stringify(payload, null, 2));
      return payload;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
