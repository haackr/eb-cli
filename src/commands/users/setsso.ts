import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

type UserSetSsoCsvRow = {
  userId?: string;
  userid?: string;
  user_id?: string;
  id?: string;
  sso?: string | boolean;
  ssoEnabled?: string | boolean;
  sso_enabled?: string | boolean;
};

type UserSetSsoOperation = {
  userId: string;
  enabled: boolean;
};

type UserSetSsoResult = {
  userId: string;
  requestedSso: boolean;
  status: 'success' | 'failed';
  visitedUrl?: string;
  message?: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['true', '1', 'yes', 'y', 'on', 'enabled', 'enable'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off', 'disabled', 'disable'].includes(normalized)) {
    return false;
  }

  return null;
}

function parseOperations(rows: UserSetSsoCsvRow[]): UserSetSsoOperation[] {
  const operations: UserSetSsoOperation[] = [];

  for (const row of rows) {
    const userId = String(row.userId ?? row.userid ?? row.user_id ?? row.id ?? '').trim();
    const enabled = parseBooleanLike(row.sso ?? row.ssoEnabled ?? row.sso_enabled);
    if (!userId || enabled === null) {
      continue;
    }

    operations.push({ userId, enabled });
  }

  return operations;
}

export default class UserSetSso extends BaseSessionCommand {
  static override summary = 'Set user SSO values from a CSV';
  static override description =
    'Set SSO true/false per user using CSV input with userId and sso columns.';
  static override args = {
    file: Args.string({
      description: 'CSV file containing userId and sso values',
      required: true,
      parse: async (input) => {
        if (!fs.existsSync(input)) {
          throw new Error(`File not found: ${input}`);
        }

        return input;
      },
    }),
  };
  static override examples = [
    'eb user setsso users-sso.csv --session-id 1',
    'eb user setsso users-sso.csv --username myuser --dry-run',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (no actual changes)' }),
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
    const { args, flags } = await this.parse(UserSetSso);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);

    const csvData = fs.readFileSync(args.file, 'utf8');
    const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    const operations = parseOperations(parsed.data as UserSetSsoCsvRow[]);
    if (operations.length === 0) {
      this.error(
        'No valid rows found. CSV must include userId and sso columns where sso is true/false.',
      );
    }

    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    const results: UserSetSsoResult[] = [];
    let updatedCount = 0;
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
                'Setting SSO [{bar}] {percentage}% | {value}/{total} users | Success: {success} | Failed: {failed}',
              hideCursor: true,
              clearOnComplete: true,
            },
            cliProgress.Presets.shades_classic,
          )
        : null;

    if (progressBar) {
      progressBar.start(operations.length, 0, { success: 0, failed: 0 });
    }

    const writeResultsCsv = (): void => {
      if (!flags['output-csv']) return;
      const rows = results.map((r) => ({
        userId: r.userId,
        requestedSso: r.requestedSso,
        status: r.status,
        visitedUrl: r.visitedUrl ?? '',
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
            updatedCount,
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
          `Interrupted. Updated: ${updatedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
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

    for (const operation of operations) {
      if (shouldStop) break;

      if (refreshCounter % 10 === 0) {
        cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
      }

      const spinner =
        flags.verbose && !this.jsonEnabled()
          ? ora(`Setting SSO for user ${operation.userId} to ${operation.enabled}`).start()
          : null;
      currentSpinner = spinner;

      try {
        const updateResult = await eb.setUserSso({
          env,
          cookies,
          browser,
          userId: operation.userId,
          enabled: operation.enabled,
          dryRun: flags['dry-run'],
        });

        if (spinner) {
          spinner.succeed(`Updated user ${operation.userId} (sso=${operation.enabled})`);
        }

        results.push({
          userId: operation.userId,
          requestedSso: operation.enabled,
          status: 'success',
          visitedUrl: updateResult.visitedUrl,
        });
        updatedCount++;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (spinner) {
          spinner.fail(`Failed user ${operation.userId}: ${message}`);
        }

        results.push({
          userId: operation.userId,
          requestedSso: operation.enabled,
          status: 'failed',
          message,
        });
        failedCount++;
      }

      currentSpinner = null;
      if (progressBar) {
        progressBar.update(refreshCounter + 1, { success: updatedCount, failed: failedCount });
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
        updatedCount,
        failedCount,
        dryRun: Boolean(flags['dry-run']),
        outputCsv: flags['output-csv'] ?? null,
        interrupted,
        results,
      };
    }

    if (interrupted) {
      this.log(
        `Interrupted. Updated: ${updatedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
          flags['dry-run'],
        )}`,
      );
    } else {
      this.log(
        `Completed. Updated: ${updatedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
          flags['dry-run'],
        )}`,
      );
    }
  }
}
