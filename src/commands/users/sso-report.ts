import { Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

type SsoReportResult = {
  userId: string;
  userName: string;
  ssoRequired?: boolean;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function defaultOutputPath(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `users-sso-report-${timestamp}.csv`;
}

export default class UsersSsoReport extends BaseSessionCommand {
  static override summary = 'Generate users SSO report';
  static override description =
    'Generate a CSV report showing whether SSO is required for every user in Manage Users.';
  static override examples = [
    'eb users sso-report --session-id 1',
    'eb users sso-report --username myuser --output-file users-sso.csv',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'output-file': Flags.string({
      char: 'o',
      description: 'Path to CSV output file',
      default: defaultOutputPath(),
    }),
    overwrite: Flags.boolean({
      description: 'Overwrite output file if it exists',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed progress for each user instead of overall progress bar',
    }),
  };

  public async run(): Promise<any> {
    const { flags } = await this.parse(UsersSsoReport);

    const outputFile = flags['output-file'];
    if (fs.existsSync(outputFile) && !flags.overwrite) {
      this.error(`Output file already exists: ${outputFile}. Use --overwrite to replace it.`);
    }

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    let interrupted = false;
    let shouldStop = false;
    let wroteCsv = false;
    let currentSpinner: ReturnType<typeof ora> | null = null;

    const users = await eb.listManagedUsers({ env, cookies, browser });
    if (users.length === 0) {
      this.error('No users found on Manage Users page.');
    }

    const results: SsoReportResult[] = [];
    let successCount = 0;
    let failedCount = 0;
    let refreshCounter = 0;

    const progressBar =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Reading SSO [{bar}] {percentage}% | {value}/{total} users | Success: {success} | Failed: {failed}',
              hideCursor: true,
              clearOnComplete: true,
            },
            cliProgress.Presets.shades_classic,
          )
        : null;

    if (progressBar) {
      progressBar.start(users.length, 0, { success: 0, failed: 0 });
    }

    const writeCsv = (): void => {
      const csv = Papa.unparse(
        results.map((r) => ({
          userId: r.userId,
          userName: r.userName,
          ssoRequired: r.ssoRequired === undefined ? '' : String(r.ssoRequired),
        })),
      );
      fs.writeFileSync(outputFile, csv, 'utf8');
      wroteCsv = true;
    };

    const handleInterrupt = async (): Promise<void> => {
      try {
        interrupted = true;
        shouldStop = true;
        if (progressBar) progressBar.stop();
        if (currentSpinner) {
          currentSpinner.stop();
          currentSpinner = null;
        }

        try {
          await eb.BrowserManager.getInstance().closeBrowser();
        } catch {}

        if (!wroteCsv) {
          writeCsv();
        }

        if (!this.jsonEnabled()) {
          this.log(`Saved partial report CSV to ${outputFile}`);
        }

        if (this.jsonEnabled()) {
          const payload = {
            outputFile,
            totalUsers: users.length,
            successCount,
            failedCount,
            interrupted: true,
            results,
          };
          process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(130));
          return;
        }

        console.log(`Interrupted. Success: ${successCount}, Failed: ${failedCount}`);
        process.exit(130);
      } catch {
        process.exit(130);
      }
    };

    process.prependOnceListener('SIGINT', handleInterrupt);
    process.prependOnceListener('SIGTERM', handleInterrupt);
    process.once('exit', () => {
      try {
        if (!wroteCsv) {
          writeCsv();
        }
      } catch {}
    });

    for (const user of users) {
      if (shouldStop) break;

      if (refreshCounter % 10 === 0) {
        cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
      }

      const spinner =
        flags.verbose && !this.jsonEnabled() ? ora(`Reading SSO for ${user.name}`).start() : null;
      currentSpinner = spinner;

      try {
        const status = await eb.getUserSsoStatus({
          env,
          cookies,
          browser,
          userId: user.userId,
          viewUrl: user.viewUrl,
        });

        if (spinner) {
          spinner.succeed(`Read ${user.name}: ${status.loginAuthentication}`);
        }

        results.push({
          userId: user.userId,
          userName: user.userName,
          ssoRequired: status.ssoRequired,
        });
        successCount++;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (spinner) {
          spinner.fail(`Failed ${user.name}: ${message}`);
        }

        results.push({
          userId: user.userId,
          userName: user.userName,
        });
        failedCount++;
      }

      currentSpinner = null;
      if (progressBar) {
        progressBar.update(refreshCounter + 1, { success: successCount, failed: failedCount });
      }

      refreshCounter++;
    }

    if (progressBar) {
      progressBar.stop();
    }

    await eb.BrowserManager.getInstance().closeBrowser();

    writeCsv();
    if (!this.jsonEnabled()) {
      this.log(`Saved SSO report CSV to ${outputFile}`);
    }

    if (this.jsonEnabled()) {
      return {
        outputFile,
        totalUsers: users.length,
        successCount,
        failedCount,
        interrupted,
        results,
      };
    }

    if (interrupted) {
      this.log(`Interrupted. Success: ${successCount}, Failed: ${failedCount}`);
    } else {
      this.log(`Completed. Success: ${successCount}, Failed: ${failedCount}`);
    }
  }
}
