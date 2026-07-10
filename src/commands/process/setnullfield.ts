import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

type SetNullFieldResult = {
  processInstanceId: string;
  status: 'success' | 'failed';
  requestedFields?: string[];
  clearedFields?: string[];
  notFoundFields?: string[];
  visitedUrl?: string;
  message?: string;
};

type SetNullFieldRow = {
  processInstanceId: string;
  fieldNames: string[];
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown error');
}

function parseSetNullFieldRows(csvData: string): SetNullFieldRow[] {
  const parsed = Papa.parse<string[]>(csvData, {
    header: false,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
  }

  const rows = parsed.data;
  if (rows.length < 2) {
    throw new Error(
      'CSV must include a header row and at least one data row. First column should be instance ID.',
    );
  }

  const bodyRows = rows.slice(1);
  const operations: SetNullFieldRow[] = [];

  for (const row of bodyRows) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }

    const processInstanceId = String(row[0] ?? '').trim();
    if (!processInstanceId) {
      continue;
    }

    const fieldNames = row
      .slice(1)
      .map((cell) => String(cell ?? '').trim())
      .filter((cell) => cell.length > 0);

    if (fieldNames.length === 0) {
      continue;
    }

    operations.push({ processInstanceId, fieldNames });
  }

  return operations;
}

export default class ProcessSetNullField extends BaseSessionCommand {
  static override summary = 'Set process instance fields to blank';
  static override description =
    'Set one or more fields to blank for each process instance from a CSV file.';
  static override args = {
    file: Args.string({
      description:
        'CSV file: first column is process instance ID; subsequent columns list field names to blank for that row',
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
    'eb process setnullfield process-null-fields.csv --session-id 1',
    'eb process setnullfield process-null-fields.csv --username myuser --dry-run',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (open and detect fields without saving)' }),
    verbose: Flags.boolean({
      char: 'v',
      description:
        'Show detailed progress for each process instance instead of overall progress bar',
    }),
    'output-csv': Flags.string({
      char: 'o',
      description: 'Write operation results to a CSV file at this path',
    }),
  };

  public async run(): Promise<any> {
    const { args, flags } = await this.parse(ProcessSetNullField);

    const csvData = fs.readFileSync(args.file, 'utf8');
    const operations = parseSetNullFieldRows(csvData);
    if (operations.length === 0) {
      this.error(
        'No process updates found in CSV. Each data row must include an instance ID and at least one field name.',
      );
    }

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);

    if (!this.jsonEnabled()) {
      this.log(
        `Using session ${session.id} (${session.username} / ${eb.getDisplayName(session.environment)} / ${session.account})`,
      );
    }

    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);
    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    const results: SetNullFieldResult[] = [];
    let updatedCount = 0;
    let failedCount = 0;
    let refreshCounter = 0;
    let shouldStop = false;
    let interrupted = false;
    let wroteCsv = false;
    let currentSpinner: ReturnType<typeof ora> | null = null;

    const progressBar =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Clearing fields [{bar}] {percentage}% | {value}/{total} instances | Success: {success} | Failed: {failed}',
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
      const csv = Papa.unparse(
        results.map((r) => ({
          processInstanceId: r.processInstanceId,
          requestedFields: (r.requestedFields ?? []).join('|'),
          status: r.status,
          clearedFields: (r.clearedFields ?? []).join('|'),
          notFoundFields: (r.notFoundFields ?? []).join('|'),
          visitedUrl: r.visitedUrl ?? '',
          message: r.message ?? '',
        })),
      );
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
            session: {
              id: session.id,
              username: session.username,
              environment: session.environment,
              account: session.account,
            },
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

      const { processInstanceId, fieldNames } = operation;

      if (refreshCounter % 10 === 0) {
        cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
      }

      const spinner =
        flags.verbose && !this.jsonEnabled()
          ? ora(`Clearing fields for process instance ${processInstanceId}`).start()
          : null;
      currentSpinner = spinner;

      try {
        const result = await eb.setProcessInstanceFieldsToNull({
          env,
          cookies,
          browser,
          processInstanceId,
          fieldNames,
          dryRun: flags['dry-run'],
        });

        if (spinner) {
          spinner.succeed(
            `Processed ${processInstanceId}. Cleared ${result.clearedFields.length}, not found ${result.notFoundFields.length}`,
          );
        }

        results.push({
          processInstanceId,
          status: 'success',
          requestedFields: fieldNames,
          clearedFields: result.clearedFields,
          notFoundFields: result.notFoundFields,
          visitedUrl: result.visitedUrl,
          ...(result.notFoundFields.length > 0
            ? { message: `Fields not found: ${result.notFoundFields.join(', ')}` }
            : {}),
        });
        updatedCount++;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (spinner) {
          spinner.fail(`Failed for ${processInstanceId}: ${message}`);
        }

        results.push({
          processInstanceId,
          status: 'failed',
          requestedFields: fieldNames,
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
        session: {
          id: session.id,
          username: session.username,
          environment: session.environment,
          account: session.account,
        },
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
