import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

type UserDeleteCsvRow = {
  userName?: string;
};

type UserDeleteResult = {
  userName?: string;
  status: 'success' | 'failed';
  message?: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

export default class UsersDelete extends BaseSessionCommand {
  static override summary = 'Delete users from a CSV';
  static override args = {
    file: Args.string({
      description: 'CSV file containing user IDs to delete',
      required: true,
      parse: async (input) => {
        if (!fs.existsSync(input)) {
          throw new Error(`File not found: ${input}`);
        }
        return input;
      },
    }),
  };
  static override description = 'Delete users from an account using CSV input';
  static override examples = [
    'eb users delete users.csv --session-id 1',
    'eb users delete users.csv --username myuser',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (no actual deletion)' }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed progress for each user instead of overall progress bar',
    }),
    'output-csv': Flags.string({
      char: 'o',
      description: 'Write operation results to a CSV file at this path',
    }),
  };

  public async run(): Promise<any> {
    const { args, flags } = await this.parse(UsersDelete);

    const session = await this.getSession(flags);

    const csvData = fs.readFileSync(args.file, 'utf8');
    const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    const users = (parsed.data as UserDeleteCsvRow[]).filter((u) => Boolean(u.userName));
    if (users.length === 0) {
      this.error('No users found in CSV. Expected columns include userId, userName, or email.');
    }

    const env = eb.getEnvironment(session.environment);
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    const results: UserDeleteResult[] = [];
    let deletedCount = 0;
    let failedCount = 0;
    let refreshCounter = 0;
    let interrupted = false;
    let shouldStop = false;
    let wroteCsv = false;
    let currentSpinner: ReturnType<typeof ora> | null = null;

    const progressBar =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Deleting users [{bar}] {percentage}% | {value}/{total} users | Success: {success} | Failed: {failed}',
              hideCursor: true,
              clearOnComplete: true,
            },
            cliProgress.Presets.shades_classic,
          )
        : null;

    if (progressBar) {
      progressBar.start(users.length, 0, { success: 0, failed: 0 });
    }

    const writeResultsCsv = (): void => {
      if (!flags['output-csv']) return;
      const rows = results.map((r) => ({
        userName: r.userName ?? '',
        status: r.status,
        message: r.message ?? '',
      }));
      const csv = Papa.unparse(rows);
      fs.writeFileSync(flags['output-csv'], csv, 'utf8');
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

        if (flags['output-csv'] && !wroteCsv) {
          writeResultsCsv();
          if (!this.jsonEnabled()) {
            this.log(`Saved partial results CSV to ${flags['output-csv']}`);
          }
        }

        if (this.jsonEnabled()) {
          const payload = {
            deletedCount,
            failedCount,
            dryRun: Boolean(flags['dry-run']),
            outputCsv: flags['output-csv'] ?? null,
            interrupted: true,
            results,
          };
          process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(130));
          return;
        }

        console.log(
          `Interrupted. Deleted: ${deletedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
            flags['dry-run'],
          )}`,
        );
        process.exit(130);
      } catch {
        process.exit(130);
      }
    };

    process.prependOnceListener('SIGINT', handleInterrupt);
    process.prependOnceListener('SIGTERM', handleInterrupt);
    process.once('exit', () => {
      try {
        if (flags['output-csv'] && !wroteCsv) {
          writeResultsCsv();
        }
      } catch {}
    });

    for (const user of users) {
      if (shouldStop) break;

      if (refreshCounter % 10 === 0) {
        cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
      }

      const displayId = user.userName || 'unknown-user';
      const spinner =
        flags.verbose && !this.jsonEnabled() ? ora(`Deleting user ${displayId}`).start() : null;
      currentSpinner = spinner;

      try {
        await eb.deleteUser({
          env,
          cookies,
          browser,
          user,
          dryRun: flags['dry-run'],
        });

        if (spinner) {
          spinner.succeed(`Deleted user ${displayId}`);
        }

        results.push({
          status: 'success',
          ...(user.userName ? { userName: user.userName } : {}),
        });
        deletedCount++;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (spinner) {
          spinner.fail(`Failed to delete user ${displayId}: ${message}`);
        }

        results.push({
          status: 'failed',
          ...(user.userName ? { userName: user.userName } : {}),
          message,
        });
        failedCount++;
      }

      currentSpinner = null;
      if (progressBar) {
        progressBar.update(refreshCounter + 1, { success: deletedCount, failed: failedCount });
      }
      refreshCounter++;
    }

    if (progressBar) {
      progressBar.stop();
    }

    await eb.BrowserManager.getInstance().closeBrowser();

    if (flags['output-csv']) {
      writeResultsCsv();
      if (!this.jsonEnabled()) {
        this.log(`Saved results CSV to ${flags['output-csv']}`);
      }
    }

    if (this.jsonEnabled()) {
      return {
        deletedCount,
        failedCount,
        dryRun: Boolean(flags['dry-run']),
        outputCsv: flags['output-csv'] ?? null,
        interrupted,
        results,
      };
    }

    if (interrupted) {
      this.log(
        `Interrupted. Deleted: ${deletedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
          flags['dry-run'],
        )}`,
      );
    } else {
      this.log(
        `Completed. Deleted: ${deletedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
          flags['dry-run'],
        )}`,
      );
    }
  }
}
