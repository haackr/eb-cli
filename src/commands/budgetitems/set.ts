import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

export default class BudgetitemsSet extends BaseSessionCommand {
  static override summary = 'Set budget item properties from a CSV';
  static override args = {
    file: Args.string({
      description: 'CSV file containing budget item properties to set',
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
  static override description = 'Set properties for budget items from a CSV file';
  static override examples = [
    'eb budgetitems set items.csv --session-id 1',
    'eb budgetitems set items.csv --username myuser',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (no actual changes)' }),
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
    const { args, flags } = await this.parse(BudgetitemsSet);

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
      allowCharges?: string;
      approvalRequiredForChange?: string;
      description?: string;
    }[];

    // Get environment
    const env = eb.getEnvironment(session.environment);

    // Get refreshed session cookies using base class method
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);

    // Set properties for each item
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
      allowCharges?: string;
      approvalRequiredForChange?: string;
      description?: string;
      status: 'success' | 'failed';
      message?: string;
    }> = [];
    let updatedCount = 0;
    let failedCount = 0;
    let refreshCounter = 0;

    // Create progress bar for non-verbose mode (but not in JSON mode)
    const progressBar =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Setting properties [{bar}] {percentage}% | {value}/{total} items | Success: {success} | Failed: {failed}',
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
    let shouldStop = false;
    let interrupted = false;
    let wroteCsv = false;

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
            allowCharges: r.allowCharges ?? '',
            approvalRequiredForChange: r.approvalRequiredForChange ?? '',
            description: r.description ?? '',
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

        // Output partial JSON or summary
        // Output partial JSON or summary immediately, then exit
        if (this.jsonEnabled()) {
          const payload = {
            updatedCount,
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
          console.log(
            `Interrupted. Updated: ${updatedCount}, Failed: ${failedCount}, Dry run: ${Boolean(
              flags['dry-run'],
            )}`,
          );
          process.exit(130);
          return;
        }
      } catch {
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
            allowCharges: r.allowCharges ?? '',
            approvalRequiredForChange: r.approvalRequiredForChange ?? '',
            description: r.description ?? '',
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
              `Setting properties for budget item ${item.itemId}${
                item.projectName ? ` - ${item.projectName}` : ''
              }${item.accountCode ? ` - ${item.accountCode}` : ''}`,
            ).start()
          : null;

      currentSpinner = spinner;

      try {
        await eb.setBudgetItemProperties({
          env,
          cookies,
          browser,
          budgetItem: {
            budgetItemId: item.itemId,
            projectId: item.portalId,
            ...(item.budgetId && { budgetId: item.budgetId }),
            ...(item.accountCode && { accountCode: item.accountCode }),
            ...(item.projectName && { projectName: item.projectName }),
            ...(item.allowCharges !== undefined && {
              allowCharges: item.allowCharges.toLowerCase() === 'true',
            }),
            ...(item.approvalRequiredForChange !== undefined && {
              approvalRequiredForChange: item.approvalRequiredForChange.toLowerCase() === 'true',
            }),
            ...(item.description && { description: item.description }),
          },
          dryRun: flags['dry-run'],
        });
        if (spinner) {
          spinner.succeed(
            `Set properties for budget item ${item.itemId}${
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
          ...(item.allowCharges ? { allowCharges: item.allowCharges } : {}),
          ...(item.approvalRequiredForChange
            ? { approvalRequiredForChange: item.approvalRequiredForChange }
            : {}),
          ...(item.description ? { description: item.description } : {}),
        });
        updatedCount++;
      } catch (e: any) {
        if (spinner) {
          spinner.fail(
            `Failed to set properties for ${item.itemId}${
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
          ...(item.allowCharges ? { allowCharges: item.allowCharges } : {}),
          ...(item.approvalRequiredForChange
            ? { approvalRequiredForChange: item.approvalRequiredForChange }
            : {}),
          ...(item.description ? { description: item.description } : {}),
          message: String(e?.message ?? ''),
        });
        failedCount++;
      }

      if (progressBar) {
        progressBar.update(refreshCounter + 1, { success: updatedCount, failed: failedCount });
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
        allowCharges: r.allowCharges ?? '',
        approvalRequiredForChange: r.approvalRequiredForChange ?? '',
        description: r.description ?? '',
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
