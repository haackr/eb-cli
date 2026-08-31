import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { parseCsv, USER_SET_FIELD_ALIASES } from '../../lib/csv.js';

type UserSetFieldCsvRow = Record<string, string | boolean | null | undefined>;

type UserSetFieldOperation = {
  userId: string;
  fieldValues: eb.UserFieldValueMap;
};

type UserSetFieldResult = {
  userId: string;
  status: 'success' | 'failed';
  requestedFields: string[];
  updatedFields?: string[];
  notFoundFields?: string[];
  visitedUrl?: string;
  message?: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function parseOperations(rows: UserSetFieldCsvRow[]): UserSetFieldOperation[] {
  const operations: UserSetFieldOperation[] = [];

  for (const row of rows) {
    const userId = String(row['userId'] ?? '').trim();
    if (!userId) {
      continue;
    }

    const fieldValues: eb.UserFieldValueMap = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'userId') {
        continue;
      }

      const trimmedValue = String(value ?? '').trim();
      if (!trimmedValue) {
        continue;
      }

      fieldValues[key] = trimmedValue;
    }

    if (Object.keys(fieldValues).length === 0) {
      continue;
    }

    operations.push({ userId, fieldValues });
  }

  return operations;
}

export default class UserSetField extends BaseSessionCommand {
  static override summary = 'Set user fields from a CSV';
  static override description =
    'Set built-in or custom user fields using CSV input where each column name is the field label.';
  static override args = {
    file: Args.string({
      description: 'CSV file containing a userId column and one or more field-value columns',
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
    'eb users setfield user-fields.csv --session-id 1',
    'eb users setfield user-fields.csv --username myuser --dry-run',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (open and detect fields without saving)' }),
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
    const { args, flags } = await this.parse(UserSetField);

    const csvData = fs.readFileSync(args.file, 'utf8');
    const parsed = parseCsv<UserSetFieldCsvRow>(csvData, USER_SET_FIELD_ALIASES);
    if (parsed.errors.length > 0) {
      this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    const operations = parseOperations(parsed.data);
    if (operations.length === 0) {
      this.error(
        'No valid rows found. CSV must include a userId column and at least one non-empty field value column per row.',
      );
    }

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );
    const context =
      (await eb.BrowserManager.getInstance().getDefaultContext(browser)) ||
      (await browser.newContext());
    await context.addCookies(eb.normalizeCookies(cookies));
    const page = await context.newPage();
    await eb.optimizePageForAutomation(page, { blockAssets: !flags['show-browser'] });

    const results: UserSetFieldResult[] = [];
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
                'Setting fields [{bar}] {percentage}% | {value}/{total} users | Success: {success} | Failed: {failed}',
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
      const rows = results.map((result) => ({
        userId: result.userId,
        requestedFields: result.requestedFields.join('|'),
        status: result.status,
        updatedFields: (result.updatedFields ?? []).join('|'),
        notFoundFields: (result.notFoundFields ?? []).join('|'),
        visitedUrl: result.visitedUrl ?? '',
        message: result.message ?? '',
      }));
      const output = Papa.unparse(rows);
      fs.writeFileSync(flags['output-csv'], output, 'utf8');
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
          await page.close().catch(() => {});
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

    try {
      for (const operation of operations) {
        if (shouldStop) break;

        if (refreshCounter % 10 === 0) {
          cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
          await context.addCookies(eb.normalizeCookies(cookies));
        }

        const requestedFields = Object.keys(operation.fieldValues);
        const spinner =
          flags.verbose && !this.jsonEnabled()
            ? ora(`Setting fields for user ${operation.userId}`).start()
            : null;
        currentSpinner = spinner;

        try {
          const updateResult = await eb.setUserFields({
            env,
            cookies,
            browser,
            page,
            userId: operation.userId,
            fieldValues: operation.fieldValues,
            dryRun: flags['dry-run'],
          });

          if (spinner) {
            spinner.succeed(
              `Processed user ${operation.userId}. Updated ${updateResult.updatedFields.length}, not found ${updateResult.notFoundFields.length}`,
            );
          }

          results.push({
            userId: operation.userId,
            status: 'success',
            requestedFields,
            updatedFields: updateResult.updatedFields,
            notFoundFields: updateResult.notFoundFields,
            visitedUrl: updateResult.visitedUrl,
            ...(updateResult.notFoundFields.length > 0
              ? { message: `Fields not found: ${updateResult.notFoundFields.join(', ')}` }
              : {}),
          });
          updatedCount++;
        } catch (error: unknown) {
          const message = toErrorMessage(error);
          if (spinner) {
            spinner.fail(`Failed user ${operation.userId}: ${message}`);
          }

          results.push({
            userId: operation.userId,
            status: 'failed',
            requestedFields,
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
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
      try {
        await page.close().catch(() => {});
      } catch {}
      await eb.BrowserManager.getInstance().closeBrowser();
    }

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
