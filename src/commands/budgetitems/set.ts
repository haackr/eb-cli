import { Args, Command, Flags } from '@oclif/core';
import { select } from '@inquirer/prompts';
import * as fs from 'fs';
import Papa from 'papaparse';
import ora from 'ora';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as db from '../../lib/db.js';
import type { SessionRow } from '../../lib/db.js';
import { promptLoginAndSaveSession, refreshSessionIfNeeded } from '../../lib/login-helper.js';

export default class BudgetitemsSet extends Command {
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
    'session-id': Flags.integer({ char: 'i', description: 'Session ID to use' }),
    username: Flags.string({
      char: 'u',
      description: 'Username to use session for',
    }),
    'show-browser': Flags.boolean({
      char: 's',
      description: 'Show browser window',
    }),
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

    // Get session
    let session: SessionRow | undefined;
    if (flags['session-id']) {
      session = db.getSessionById(flags['session-id']) as SessionRow;
      if (!session) {
        this.error(`Session with ID ${flags['session-id']} not found.`);
      }
    } else if (flags.username) {
      const sessions = db.getSessionsByUsername(flags.username) as SessionRow[];
      if (sessions.length === 0) {
        this.error(`No sessions found for username ${flags.username}.`);
      } else if (sessions.length === 1) {
        session = sessions[0];
      } else {
        // Multiple sessions, prompt to select
        const choices = sessions.map((s) => ({
          name: `${s.username} (${eb.getDisplayName(s.environment)}/${
            s.account
          }) - ${s.created_at}`,
          value: s,
        }));
        session = await select({
          message: 'Select a session:',
          choices,
        });
      }
    } else {
      // No session specified, check if any sessions exist
      const allSessions = db.getSessions() as SessionRow[];
      if (allSessions.length === 0) {
        // No sessions, prompt to login
        this.log('No open sessions found. Please log in first.');
        await promptLoginAndSaveSession({ showBrowser: flags['show-browser'] });
        // After login, get the new session
        const newSessions = db.getSessions() as SessionRow[];
        if (newSessions.length === 1) {
          session = newSessions[0];
        } else {
          // Prompt to select
          const choices = newSessions.map((s) => ({
            name: `${s.username} (${eb.getDisplayName(s.environment)}/${
              s.account
            }) - ${s.created_at}`,
            value: s,
          }));
          session = await select({
            message: 'Select a session:',
            choices,
          });
        }
      } else if (allSessions.length === 1) {
        session = allSessions[0];
      } else {
        // Prompt to select
        const choices = allSessions.map((s) => ({
          name: `${s.username} (${eb.getDisplayName(s.environment)}/${s.account}) - ${s.created_at}`,
          value: s,
        }));
        session = await select({
          message: 'Select a session:',
          choices,
        });
      }
    }

    if (!session) {
      this.error('No session selected.');
    }

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

    let cookies = JSON.parse(session.session_cookies);

    // Check and refresh session
    if (!(await refreshSessionIfNeeded(session.id, !flags['show-browser']))) {
      this.error("Session has expired. Please log in again using 'eb login'.");
    }
    // Re-parse cookies after refresh
    const refreshedSession = db.getSessionById(session.id) as SessionRow;
    cookies = JSON.parse(refreshedSession.session_cookies);

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
        if (!(await refreshSessionIfNeeded(session.id, !flags['show-browser']))) {
          if (progressBar) progressBar.stop();
          this.error("Session has expired during operation. Please log in again using 'eb login'.");
        }
        const refreshedSession2 = db.getSessionById(session.id) as SessionRow;
        cookies = JSON.parse(refreshedSession2.session_cookies);
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
