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
      const results: RemoveProjectRoleResult[] = [];
      const progress =
        !flags.verbose &&
        !this.jsonEnabled() &&
        new cliProgress.SingleBar({ clearOnComplete: true }, cliProgress.Presets.shades_classic);
      if (progress) progress.start(total, 0);

      let refreshCounter = 0;
      for (const group of groupList) {
        if (refreshCounter % 10 === 0) {
          cookies = await this.refreshSessionCookies(session.id, !flags['show-browser']);
        }
        refreshCounter++;

        const { projectName, roleName, users } = group;
        let status: RemoveProjectRoleResult['status'] = 'success';
        let message = '';
        try {
          const { notFound } = await eb.removeUserFromProjectRoleByName({
            env,
            cookies,
            browser,
            projectName,
            roleName,
            userNames: users,
            dryRun: Boolean(flags['dry-run']),
          });
          const notFoundSet = new Set(notFound.map((u) => u.trim().toLowerCase()));
          for (const userName of users) {
            const skipped = notFoundSet.has(userName.trim().toLowerCase());
            message = skipped ? 'Not found (skipped)' : flags['dry-run'] ? 'Dry run' : 'Removed';
            status = 'success';
            if (flags.verbose)
              this.log(
                skipped
                  ? `[Skipped] User '${userName}' not found in role '${roleName}' in project '${projectName}'`
                  : flags['dry-run']
                    ? `[Dry run] Would remove user '${userName}' from role '${roleName}' in project '${projectName}'`
                    : `Removed user '${userName}' from role '${roleName}' in project '${projectName}'`,
              );
            results.push({ projectName, roleName, userName, status, message });
            if (progress) progress.increment();
          }
        } catch (error) {
          status = 'failed';
          message = toErrorMessage(error);
          for (const userName of users) {
            if (flags.verbose)
              this.log(
                `Failed to remove user '${userName}' from role '${roleName}' in project '${projectName}': ${message}`,
              );
            results.push({ projectName, roleName, userName, status, message });
            if (progress) progress.increment();
          }
        }
      }
      if (progress) progress.stop();

      if (flags['output-csv']) {
        const csv = Papa.unparse(results);
        fs.writeFileSync(flags['output-csv'], csv, 'utf8');
        this.log(`Results written to ${flags['output-csv']}`);
      }

      if (flags.json) {
        return results;
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

      if (flags['dry-run']) {
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
