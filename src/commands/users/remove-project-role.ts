import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import { parseCsv, USER_REMOVE_PROJECT_ROLE_ALIASES } from '../../lib/csv.js';

type RemoveProjectRoleCsvRow = {
  projectName?: string;
  roleName?: string;
  userName?: string;
};

type RemoveProjectRoleResult = {
  projectName?: string;
  roleName?: string;
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

export default class UsersRemoveProjectRole extends BaseSessionCommand {
  static override summary = 'Remove users from project roles from a CSV';
  static override args = {
    file: Args.string({
      description: 'CSV file containing projectName, roleName, userName',
      required: true,
      parse: async (input) => {
        if (!fs.existsSync(input)) {
          throw new Error(`File not found: ${input}`);
        }
        return input;
      },
    }),
  };
  static override description = 'Remove users from project roles using CSV input';
  static override examples = [
    'eb users remove-project-role remove-users.csv --session-id 1',
    'eb users remove-project-role remove-users.csv --username myuser',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    'dry-run': Flags.boolean({ description: 'Dry run (no actual removal)' }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed progress for each row instead of overall progress bar',
    }),
    'output-csv': Flags.string({
      char: 'o',
      description: 'Write operation results to a CSV file at this path',
    }),
  };

  public async run(): Promise<any> {
    const { args, flags } = await this.parse(UsersRemoveProjectRole);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    let cookies = await this.getSessionCookies(session.id, !flags['show-browser']);
    const browserManager = eb.BrowserManager.getInstance();
    const browser = await browserManager.getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    let wroteCsv = false;
    let interrupted = false;
    let shouldStop = false;
    const results: RemoveProjectRoleResult[] = [];
    const resultMap = new Map<string, RemoveProjectRoleResult>();

    function getResultKey(projectName: string, roleName: string, userName: string): string {
      return `${projectName.trim()}|||${roleName.trim()}|||${userName.trim().toLowerCase()}`;
    }

    const writeResultsCsv = (): void => {
      if (!flags['output-csv']) return;
      const csv = Papa.unparse(results);
      fs.writeFileSync(flags['output-csv'], csv, 'utf8');
      wroteCsv = true;
    };

    let progressBar: cliProgress.SingleBar | null = null;

    const handleInterrupt = async (): Promise<void> => {
      try {
        interrupted = true;
        shouldStop = true;
        if (progressBar) progressBar.stop();
        try {
          await browserManager.closeBrowser();
        } catch {}

        if (flags['output-csv'] && !wroteCsv) {
          writeResultsCsv();
          if (!this.jsonEnabled()) {
            this.log(`Saved partial results CSV to ${flags['output-csv']}`);
          }
        }

        const removedCount = results.filter(
          (r) =>
            r.status === 'success' &&
            !r.message?.includes('Not found') &&
            !r.message?.includes('Dry run'),
        ).length;
        const dryRunCount = results.filter(
          (r) => r.status === 'success' && r.message?.includes('Dry run'),
        ).length;
        const skippedCount = results.filter(
          (r) => r.status === 'success' && r.message?.includes('Not found'),
        ).length;
        const failedCount = results.filter((r) => r.status === 'failed').length;

        if (this.jsonEnabled()) {
          const payload = {
            removedCount,
            dryRunCount,
            skippedCount,
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
          `Interrupted. Removed: ${removedCount}, Dry run: ${dryRunCount}, Not found: ${skippedCount}, Failed: ${failedCount}`,
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
      // Parse CSV
      const csvData = fs.readFileSync(args.file, 'utf8');
      const parsed = parseCsv<RemoveProjectRoleCsvRow>(csvData, USER_REMOVE_PROJECT_ROLE_ALIASES);
      if (parsed.errors.length > 0) {
        this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
      }
      const rows = parsed.data;

      // Group by projectName and roleName
      const groupMap = new Map<
        string,
        { projectName: string; roleName: string; users: string[] }
      >();
      for (const row of rows) {
        const { projectName, roleName, userName } = row;
        if (!projectName || !roleName || !userName) continue;
        const key = `${projectName.trim()}|||${roleName.trim()}`;
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            projectName: projectName.trim(),
            roleName: roleName.trim(),
            users: [],
          });
        }
        groupMap.get(key)!.users.push(userName.trim());
      }

      const groupList = Array.from(groupMap.values());
      const total = groupList.reduce((sum, g) => sum + g.users.length, 0);

      progressBar =
        !flags.verbose && !this.jsonEnabled()
          ? new cliProgress.SingleBar(
              {
                format:
                  'Removing users from roles [{bar}] {percentage}% | {value}/{total} users | Removed: {removed} | Skipped: {skipped} | Failed: {failed}',
                hideCursor: true,
                clearOnComplete: true,
              },
              cliProgress.Presets.shades_classic,
            )
          : null;

      let removedTotal = 0;
      let skippedTotal = 0;
      let failedTotal = 0;

      if (progressBar) {
        progressBar.start(total, 0, {
          removed: 0,
          skipped: 0,
          failed: 0,
        });
      }

      let refreshCounter = 0;
      for (const group of groupList) {
        if (shouldStop) break;

        if (refreshCounter % 10 === 0) {
          cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
        }
        refreshCounter++;

        const { projectName, roleName, users } = group;

        const recordProcessed = (
          processed: { userName: string; status: 'success' | 'failed'; message: string }[],
        ) => {
          for (const item of processed) {
            const rKey = getResultKey(projectName, roleName, item.userName);
            if (!resultMap.has(rKey)) {
              const res: RemoveProjectRoleResult = {
                projectName,
                roleName,
                userName: item.userName,
                status: item.status,
                message: item.message,
              };
              resultMap.set(rKey, res);
              results.push(res);

              if (item.status === 'success') {
                if (item.message.includes('Not found')) {
                  skippedTotal++;
                } else {
                  removedTotal++;
                }
              } else {
                failedTotal++;
              }

              if (flags.verbose) {
                if (item.status === 'failed') {
                  this.log(
                    `Failed to remove user '${item.userName}' from role '${roleName}' in project '${projectName}': ${item.message}`,
                  );
                } else if (item.message.includes('Not found')) {
                  this.log(
                    `[Skipped] User '${item.userName}' not found in role '${roleName}' in project '${projectName}'`,
                  );
                } else if (flags['dry-run']) {
                  this.log(
                    `[Dry run] Would remove user '${item.userName}' from role '${roleName}' in project '${projectName}'`,
                  );
                } else {
                  this.log(
                    `Removed user '${item.userName}' from role '${roleName}' in project '${projectName}'`,
                  );
                }
              }

              if (progressBar) {
                progressBar.increment({
                  removed: removedTotal,
                  skipped: skippedTotal,
                  failed: failedTotal,
                });
              }
            }
          }
        };

        try {
          await eb.removeUserFromProjectRoleByName({
            env,
            cookies,
            browser,
            projectName,
            roleName,
            userNames: users,
            dryRun: Boolean(flags['dry-run']),
            onUsersProcessed: (batch) => recordProcessed(batch),
            refreshCookies: async () =>
              this.refreshSessionCookies(session.id, !flags['show-browser']),
          });
        } catch (error) {
          const errMsg = toErrorMessage(error);
          const unprocessed = users.filter(
            (u) => !resultMap.has(getResultKey(projectName, roleName, u)),
          );
          recordProcessed(
            unprocessed.map((userName) => ({
              userName,
              status: 'failed',
              message: errMsg,
            })),
          );
        }
      }

      if (progressBar) {
        progressBar.stop();
      }

      if (flags['output-csv']) {
        writeResultsCsv();
        if (!this.jsonEnabled()) {
          this.log(`Results written to ${flags['output-csv']}`);
        }
      }

      const removedCount = results.filter(
        (r) =>
          r.status === 'success' &&
          !r.message?.includes('Not found') &&
          !r.message?.includes('Dry run'),
      ).length;
      const dryRunCount = results.filter(
        (r) => r.status === 'success' && r.message?.includes('Dry run'),
      ).length;
      const skippedCount = results.filter(
        (r) => r.status === 'success' && r.message?.includes('Not found'),
      ).length;
      const failedCount = results.filter((r) => r.status === 'failed').length;

      if (flags.json) {
        return results;
      }

      if (interrupted) {
        this.log(
          `\nInterrupted. Removed: ${removedCount}, Not found (skipped): ${skippedCount}, Failed: ${failedCount}`,
        );
      } else if (flags['dry-run']) {
        this.log(
          `\n[Dry run] Would remove: ${dryRunCount}, Not found (skipped): ${skippedCount}, Failed: ${failedCount}`,
        );
      } else {
        this.log(
          `\nSummary: ${removedCount} removed, ${skippedCount} not found (skipped), ${failedCount} failed.`,
        );
      }

      if (failedCount > 0 && !flags.verbose) {
        this.log('\nFailed items:');
        for (const item of results.filter((r) => r.status === 'failed')) {
          this.log(
            `  - ${item.userName} (${item.roleName} in ${item.projectName}): ${item.message}`,
          );
        }
      }

      if (skippedCount > 0 && !flags.verbose) {
        this.log('\nNot found / skipped items:');
        for (const item of results.filter(
          (r) => r.status === 'success' && r.message?.includes('Not found'),
        )) {
          this.log(
            `  - ${item.userName} not found in role '${item.roleName}' in project '${item.projectName}'`,
          );
        }
      }
    } finally {
      await browserManager.closeBrowser();
    }
  }
}
