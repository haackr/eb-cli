import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

export default class BudgetitemsDelete extends BaseSessionCommand {
  static override summary = 'Delete budget items from a CSV';
  static override args = {
    file: Args.string({
      description: 'CSV file containing budget item IDs to delete',
      required: true,
      // Validate the file exists early
      parse: async (input) => {
        if (!fs.existsSync(input)) {
          throw new Error(`File not found: ${input}`);
        }
        return input;
      },
    }),
  };
  static override description = 'Delete budget items from a CSV file';
  static override examples = [
    'eb budgetitems delete items.csv --session-id 1',
    'eb budgetitems delete items.csv --username myuser',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (no actual deletion)' }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed progress for each item instead of overall progress bar',
    }),
    'output-csv': Flags.string({
      char: 'o',
      description: 'Write operation results to a CSV file at this path',
    }),
  };

  public async run(): Promise<any> {
    const { args, flags } = await this.parse(BudgetitemsDelete);

    // Get session using base class method
    const session = await this.getSession(flags);

    // Parse CSV
    const csvData = fs.readFileSync(args.file, 'utf8');
    const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }
    const items = parsed.data as {
      portalId: string;
      itemId: string;
      budgetId?: string;
      accountCode?: string;
      projectName?: string;
    }[];

    // Get environment
    const env = eb.getEnvironment(session.environment);

    // Get refreshed session cookies using base class method
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    // Delete each item
    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    const results: Array<{
      itemId: string;
      portalId?: string;
      budgetId?: string;
      projectName?: string;
      accountCode?: string;
      status: 'success' | 'failed';
      message?: string;
    }> = [];
    let deletedCount = 0;
    let failedCount = 0;
    let refreshCounter = 0;

    // Create progress bar for non-verbose mode (but not in JSON mode)
    const progressBar =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Deleting items [{bar}] {percentage}% | {value}/{total} items | Success: {success} | Failed: {failed}',
              hideCursor: true,
              clearOnComplete: true,
            },
            cliProgress.Presets.shades_classic,
          )
        : null;

    if (progressBar) {
      progressBar.start(items.length, 0, { success: 0, failed: 0 });
    }

    // Track current spinner to stop cleanly on interrupt
    let currentSpinner: ReturnType<typeof ora> | null = null;
    let wroteCsv = false;
    let shouldStop = false;
    let interrupted = false;

    // Graceful interrupt: write partial CSV/JSON and cleanup
    const handleInterrupt = async (): Promise<void> => {
      try {
        interrupted = true;
        shouldStop = true;
        if (progressBar) progressBar.stop();
        if (currentSpinner) {
          currentSpinner.stop();
          currentSpinner = null;
        }
        // Attempt to close browser
        try {
          await eb.BrowserManager.getInstance().closeBrowser();
        } catch {}

        // Optionally write partial results to CSV
        if (flags['output-csv'] && !wroteCsv) {
          const rows = results.map((r) => ({
            portalId: r.portalId ?? '',
            budgetId: r.budgetId ?? '',
            itemId: r.itemId,
            projectName: r.projectName ?? '',
            accountCode: r.accountCode ?? '',
            status: r.status,
            message: r.message ?? '',
          }));
          const csv = Papa.unparse(rows);
          fs.writeFileSync(flags['output-csv'], csv, 'utf8');
          wroteCsv = true;
          if (!this.jsonEnabled()) {
            this.log(`Saved partial results CSV to ${flags['output-csv']}`);
          }
        }

        // Output partial JSON or summary immediately, then exit
        if (this.jsonEnabled()) {
          const payload = {
            deletedCount,
            failedCount,
            dryRun: Boolean(flags['dry-run']),
            outputCsv: flags['output-csv'] ?? null,
            interrupted: true,
            results,
          };
          const json = JSON.stringify(payload) + '\n';
          process.stdout.write(json, () => process.exit(130));
          return;
        } else {
          // Use console.log to bypass any oclif UX buffering

          console.log(
            `Interrupted. Deleted: ${deletedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
              flags['dry-run'],
            )}`,
          );
          process.exit(130);
          return;
        }
      } catch {
        // As a fallback, exit with 130
        process.exit(130);
      }
    };
    process.prependOnceListener('SIGINT', handleInterrupt);
    process.prependOnceListener('SIGTERM', handleInterrupt);
    process.once('exit', () => {
      try {
        if (flags['output-csv'] && !wroteCsv) {
          const rows = results.map((r) => ({
            portalId: r.portalId ?? '',
            budgetId: r.budgetId ?? '',
            itemId: r.itemId,
            projectName: r.projectName ?? '',
            accountCode: r.accountCode ?? '',
            status: r.status,
            message: r.message ?? '',
          }));
          const csv = Papa.unparse(rows);
          fs.writeFileSync(flags['output-csv'], csv, 'utf8');
        }
      } catch {}
    });

    for (const item of items) {
      if (shouldStop) break;
      if (!item.itemId) continue;

      // Refresh session every 10 items
      if (refreshCounter % 10 === 0) {
        cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
      }

      const spinner =
        flags.verbose && !this.jsonEnabled()
          ? ora(
              `Deleting budget item ${item.itemId}${
                item.projectName ? ` - ${item.projectName}` : ''
              }${item.accountCode ? ` - ${item.accountCode}` : ''}`,
            ).start()
          : null;
      currentSpinner = spinner;

      try {
        await eb.deleteBudgetItem({
          env,
          cookies,
          browser,
          budgetItem: {
            budgetItemId: item.itemId,
            projectId: item.portalId,
            ...(item.budgetId && { budgetId: item.budgetId }),
          },
          dryRun: flags['dry-run'],
        });
        if (spinner) {
          spinner.succeed(
            `Deleted budget item ${item.itemId}${
              item.projectName ? ` - ${item.projectName}` : ''
            }${item.accountCode ? ` - ${item.accountCode}` : ''}`,
          );
        }
        currentSpinner = null;
        results.push({
          itemId: item.itemId,
          status: 'success',
          ...(item.portalId ? { portalId: item.portalId } : {}),
          ...(item.budgetId ? { budgetId: item.budgetId } : {}),
          ...(item.projectName ? { projectName: item.projectName } : {}),
          ...(item.accountCode ? { accountCode: item.accountCode } : {}),
        });
        deletedCount++;
        currentSpinner = null;
      } catch (e: any) {
        if (spinner) {
          spinner.fail(
            `Failed to delete ${item.itemId}${
              item.projectName ? ` - ${item.projectName}` : ''
            }${item.accountCode ? ` - ${item.accountCode}` : ''}: ${e.message}`,
          );
        }
        currentSpinner = null;
        results.push({
          itemId: item.itemId,
          status: 'failed',
          ...(item.portalId ? { portalId: item.portalId } : {}),
          ...(item.budgetId ? { budgetId: item.budgetId } : {}),
          ...(item.projectName ? { projectName: item.projectName } : {}),
          ...(item.accountCode ? { accountCode: item.accountCode } : {}),
          message: String(e?.message ?? ''),
        });
        failedCount++;
        currentSpinner = null;
      }

      if (progressBar) {
        progressBar.update(refreshCounter + 1, { success: deletedCount, failed: failedCount });
      }

      refreshCounter++;
    }

    if (progressBar) {
      progressBar.stop();
    }

    // Close browser
    await eb.BrowserManager.getInstance().closeBrowser();

    // Optionally write results to CSV
    if (flags['output-csv']) {
      const rows = results.map((r) => ({
        portalId: r.portalId ?? '',
        budgetId: r.budgetId ?? '',
        itemId: r.itemId,
        projectName: r.projectName ?? '',
        accountCode: r.accountCode ?? '',
        status: r.status,
        message: r.message ?? '',
      }));
      const csv = Papa.unparse(rows);
      fs.writeFileSync(flags['output-csv'], csv, 'utf8');
      wroteCsv = true;
      if (!this.jsonEnabled()) {
        this.log(`Saved results CSV to ${flags['output-csv']}`);
      }
    }

    // Output summary or JSON
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
