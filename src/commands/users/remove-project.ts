import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import cliProgress from 'cli-progress';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';

type RemoveProjectCsvRow = {
  projectName?: string;
  userName?: string;
};

type RemoveProjectResult = {
  projectName?: string;
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

export default class UsersRemoveProject extends BaseSessionCommand {
  static override summary = 'Remove users from projects from a CSV';
  static override args = {
    file: Args.string({
      description: 'CSV file containing projectName, userName',
      required: true,
      parse: async (input) => {
        if (!fs.existsSync(input)) {
          throw new Error(`File not found: ${input}`);
        }

        return input;
      },
    }),
  };
  static override description = 'Remove users from projects using CSV input';
  static override examples = [
    'eb users remove-project remove-users.csv --session-id 1',
    'eb users remove-project remove-users.csv --username myuser',
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
    const { args, flags } = await this.parse(UsersRemoveProject);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const cookies = await this.getSessionCookies(session.id, !flags['show-browser']);
    const browserManager = eb.BrowserManager.getInstance();
    const browser = await browserManager.getBrowser(
      !flags['show-browser'],
      !flags['show-browser'] ? ['--window-size=1200,800'] : undefined,
    );

    try {
      // Parse CSV
      const csvData = fs.readFileSync(args.file, 'utf8');
      const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
      if (parsed.errors.length > 0) {
        this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
      }
      const rows = parsed.data as RemoveProjectCsvRow[];

      // Group by projectName
      const groupMap = new Map<string, { projectName: string; users: string[] }>();
      for (const row of rows) {
        const { projectName, userName } = row;
        if (!projectName || !userName) continue;
        if (!groupMap.has(projectName)) {
          groupMap.set(projectName, { projectName, users: [] });
        }

        groupMap.get(projectName)!.users.push(userName);
      }

      const groupList = Array.from(groupMap.values());
      const total = groupList.reduce((sum, g) => sum + g.users.length, 0);
      const results: RemoveProjectResult[] = [];
      const progress =
        !flags.verbose &&
        new cliProgress.SingleBar({ clearOnComplete: true }, cliProgress.Presets.shades_classic);
      if (progress) progress.start(total, 0);

      for (const group of groupList) {
        const { projectName, users } = group;
        let status: RemoveProjectResult['status'] = 'success';
        let message = '';
        try {
          const { notFound } = await eb.removeUserFromProjectByName({
            env,
            cookies,
            browser,
            projectName,
            userNames: users,
            dryRun: Boolean(flags['dry-run']),
          });

          const notFoundSet = new Set(notFound);
          for (const userName of users) {
            const skipped = notFoundSet.has(userName);
            message = skipped ? 'Not found (skipped)' : flags['dry-run'] ? 'Dry run' : 'Removed';
            status = 'success';
            if (flags.verbose)
              this.log(
                skipped
                  ? `[Skipped] User '${userName}' not found in project '${projectName}'`
                  : flags['dry-run']
                    ? `[Dry run] Would remove user '${userName}' from project '${projectName}'`
                    : `Removed user '${userName}' from project '${projectName}'`,
              );
            results.push({ projectName, userName, status, message });
            if (progress) progress.increment();
          }
        } catch (error) {
          status = 'failed';
          message = toErrorMessage(error);
          for (const userName of users) {
            if (flags.verbose)
              this.log(
                `Failed to remove user '${userName}' from project '${projectName}': ${message}`,
              );
            results.push({ projectName, userName, status, message });
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

      this.log('Done.');
    } finally {
      await browserManager.closeBrowser();
    }
  }
}
