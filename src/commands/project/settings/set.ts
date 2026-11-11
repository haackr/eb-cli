import { Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import Papa from 'papaparse';
import cliProgress from 'cli-progress';
import * as eb from '../../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../../lib/base-session-command.js';
import { parseCsv, PROJECT_SETTINGS_ALIASES } from '../../../lib/csv.js';
import {
  formatSettingValue,
  parseProjectSettingsInput,
  PROJECT_SETTING_KEYS,
  PROJECT_SETTING_LABELS,
  setProjectSettings,
  type ProjectSettingChange,
  type ProjectSettingsInput,
  type ProjectSettingsUpdate,
  type SetProjectSettingsResult,
} from '../../../lib/eb-puppetmaster/project-settings.js';

type CsvRow = { project?: string } & ProjectSettingsInput;

type BatchResult = {
  row: number;
  project: string;
  projectId: string;
  status: 'updated' | 'unchanged' | 'dry-run' | 'failed';
  changes: string;
  message: string;
};

const settingFlagNames = [
  'access',
  'deny-techsupport',
  'document-control',
  'due-date-offset',
  'work-start',
  'work-end',
  'work-week',
] as const;

function describeChanges(changes: ProjectSettingChange[]): string {
  return changes
    .map(
      (c) =>
        `${PROJECT_SETTING_LABELS[c.setting]}: ${formatSettingValue(c.from)} → ${formatSettingValue(c.to)}`,
    )
    .join('; ');
}

export default class ProjectSettingsSet extends BaseSessionCommand {
  static override summary = "Change a project's settings (Project Details → Settings tab)";
  static override description = `Sets Project Access, Deny Techsupport Access, Enable Document Control, Workflow Due Date Offset, Work Day Start/End Time and Work Week, then saves and reads the values back to confirm them. Settings you don't pass are left unchanged, and nothing is saved when the project already matches.

Use flags for one project, or --file for a CSV with a "project" column (name or PortalID) and one column per setting: projectAccess, denyTechsupport, documentControl, workflowDueDateOffset, workDayStart, workDayEnd, workWeek. Blank cells are left unchanged. Every row is validated before anything is saved.

Values: access visible|hidden; yes/no for the yes/no settings; whole-hour times ("7:00 am", "7am", "15:00"); work week as days ("mon,tue,wed,thu,fri", "mon-fri", "weekdays").`;
  static override examples = [
    '<%= config.bin %> <%= command.id %> "RH - eB-CLI Test project" --work-week mon-fri --work-start 7am --work-end 4pm',
    '<%= config.bin %> <%= command.id %> 9869854c-4c8d-4638-8b5e-e52d08103c12 --access hidden --dry-run --json',
    '<%= config.bin %> <%= command.id %> --file settings.csv -o results.csv',
  ];
  static override enableJsonFlag = true;
  static override args = {
    project: Args.string({
      description:
        'Exact project name (case-insensitive) or PortalID GUID; hidden projects need the PortalID. Omit when using --file.',
      required: false,
    }),
  };
  static override flags = {
    ...BaseSessionCommand.baseFlags,
    access: Flags.string({
      description: 'Project Access',
      options: ['visible', 'hidden'],
    }),
    'deny-techsupport': Flags.string({
      description: 'Deny Techsupport Access (yes = e-Builder employees cannot access the project)',
      options: ['yes', 'no'],
    }),
    'document-control': Flags.string({
      description: 'Enable Document Control',
      options: ['yes', 'no'],
    }),
    'due-date-offset': Flags.string({
      description: 'Workflow Due Date Offset (whole number)',
    }),
    'work-start': Flags.string({ description: 'Work Day Start Time, e.g. "7:00 am"' }),
    'work-end': Flags.string({ description: 'Work Day End Time, e.g. "3:00 pm"' }),
    'work-week': Flags.string({
      description: 'Working days, e.g. "mon,tue,wed,thu,fri", "mon-fri" or "weekdays"',
    }),
    file: Flags.string({
      char: 'f',
      description: 'CSV with a project column and one column per setting',
      exclusive: [...settingFlagNames],
    }),
    'dry-run': Flags.boolean({
      description: 'Show what would change without saving',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: '(--file) Print each project instead of a progress bar',
    }),
    'output-csv': Flags.string({
      char: 'o',
      description: '(--file) Write per-project results to this CSV',
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ProjectSettingsSet);
    if (flags.file) {
      if (args.project) this.error('Pass either a project or --file, not both.');
      return await this.runBatch(flags);
    }
    if (!args.project) this.error('Pass a project name or PortalID, or use --file.');

    let settings: ProjectSettingsUpdate;
    try {
      settings = parseProjectSettingsInput({
        projectAccess: flags.access,
        denyTechsupport: flags['deny-techsupport'],
        documentControl: flags['document-control'],
        workflowDueDateOffset: flags['due-date-offset'],
        workDayStart: flags['work-start'],
        workDayEnd: flags['work-end'],
        workWeek: flags['work-week'],
      });
    } catch (e: any) {
      this.error(e.message);
    }
    if (!Object.keys(settings).length) {
      this.error(`Pass at least one setting: ${settingFlagNames.map((f) => `--${f}`).join(', ')}`);
    }

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const result = await this.withSessionCookies(session.id, !flags['show-browser'], (cookies) =>
        setProjectSettings({
          env,
          cookies,
          project: args.project!,
          settings,
          dryRun: flags['dry-run'],
        }),
      );
      if (!this.jsonEnabled()) this.logResult(result);
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }

  private logResult(result: SetProjectSettingsResult): void {
    const name = result.project.name;
    if (!result.changes.length) {
      this.log(`No changes: ${name} already has these settings.`);
      return;
    }
    this.log(
      result.saved
        ? `Saved ${result.changes.length} change(s) on ${name}:`
        : `Dry run: would change ${result.changes.length} setting(s) on ${name}:`,
    );
    for (const c of result.changes) {
      this.log(
        `  ${PROJECT_SETTING_LABELS[c.setting]}: ${formatSettingValue(c.from)} → ${formatSettingValue(c.to)}`,
      );
    }
  }

  private async runBatch(flags: {
    file?: string | undefined;
    'dry-run': boolean;
    verbose?: boolean | undefined;
    'output-csv'?: string | undefined;
    'show-browser'?: boolean | undefined;
    'session-id'?: number | undefined;
    username?: string | undefined;
    account?: string | undefined;
  }): Promise<unknown> {
    const file = flags.file!;
    if (!fs.existsSync(file)) this.error(`File not found: ${file}`);
    const parsed = parseCsv<CsvRow>(fs.readFileSync(file, 'utf8'), PROJECT_SETTINGS_ALIASES);
    if (parsed.errors.length > 0) {
      this.error(`CSV parsing errors: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    // Validate every row before opening a browser.
    const jobs: { row: number; project: string; settings: ProjectSettingsUpdate }[] = [];
    const problems: string[] = [];
    parsed.data.forEach((raw, i) => {
      const row = i + 2; // header is line 1
      const project = String(raw.project ?? '').trim();
      if (!project) {
        problems.push(`Row ${row}: missing project`);
        return;
      }
      try {
        const input: ProjectSettingsInput = {};
        for (const key of PROJECT_SETTING_KEYS) input[key] = raw[key];
        const settings = parseProjectSettingsInput(input);
        if (!Object.keys(settings).length) {
          problems.push(`Row ${row} (${project}): no settings given`);
          return;
        }
        jobs.push({ row, project, settings });
      } catch (e: any) {
        problems.push(`Row ${row} (${project}): ${e.message}`);
      }
    });
    if (problems.length) this.error(`Invalid CSV:\n  ${problems.join('\n  ')}`);
    if (!jobs.length) this.error('The CSV has no rows to process.');

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const headless = !flags['show-browser'];
    const dryRun = flags['dry-run'];
    const results: BatchResult[] = [];
    const counts = () => ({
      updated: results.filter((r) => r.status === 'updated').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      dryRun: results.filter((r) => r.status === 'dry-run').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
    let wroteCsv = false;
    const writeCsv = () => {
      if (!flags['output-csv'] || wroteCsv) return;
      fs.writeFileSync(
        flags['output-csv'],
        Papa.unparse(results, {
          columns: ['row', 'project', 'projectId', 'status', 'changes', 'message'],
        }),
        'utf8',
      );
      wroteCsv = true;
    };
    const payload = (interrupted: boolean) => ({
      ...counts(),
      dryRun,
      outputCsv: flags['output-csv'] ?? null,
      interrupted,
      results,
    });

    const progress =
      !flags.verbose && !this.jsonEnabled()
        ? new cliProgress.SingleBar(
            {
              format:
                'Project settings [{bar}] {value}/{total} | Updated: {updated} | Unchanged: {unchanged} | Failed: {failed}',
              hideCursor: true,
              clearOnComplete: true,
            },
            cliProgress.Presets.shades_classic,
          )
        : null;

    let stop = false;
    const onInterrupt = async () => {
      stop = true;
      progress?.stop();
      await eb.BrowserManager.getInstance()
        .closeBrowser()
        .catch(() => {});
      writeCsv();
      if (this.jsonEnabled()) {
        process.stdout.write(JSON.stringify(payload(true)) + '\n', () => process.exit(130));
        return;
      }
      const c = counts();
      console.log(
        `Interrupted. Updated: ${c.updated}, Unchanged: ${c.unchanged}, Failed: ${c.failed}${flags['output-csv'] ? `. Partial results in ${flags['output-csv']}` : ''}`,
      );
      process.exit(130);
    };
    process.prependOnceListener('SIGINT', onInterrupt);
    process.prependOnceListener('SIGTERM', onInterrupt);

    const browserManager = eb.BrowserManager.getInstance();
    try {
      const browser = await browserManager.getBrowser(
        headless,
        headless ? ['--window-size=1440,900'] : undefined,
      );
      let cookies: any[] = [];
      progress?.start(jobs.length, 0, counts());

      for (const [index, job] of jobs.entries()) {
        if (stop) break;
        if (index % 10 === 0) {
          cookies = await this.refreshSessionCookies(session.id, headless);
        }
        const base = { row: job.row, project: job.project, projectId: '', changes: '' };
        try {
          const result = await setProjectSettings({
            env,
            cookies,
            browser,
            project: job.project,
            settings: job.settings,
            dryRun,
          });
          const status: BatchResult['status'] = !result.changes.length
            ? 'unchanged'
            : result.saved
              ? 'updated'
              : 'dry-run';
          results.push({
            ...base,
            project: result.project.name,
            projectId: result.project.id,
            status,
            changes: describeChanges(result.changes),
            message: '',
          });
          if (flags.verbose && !this.jsonEnabled()) {
            this.log(
              `[${status}] ${result.project.name}${result.changes.length ? `: ${describeChanges(result.changes)}` : ''}`,
            );
          }
        } catch (e: any) {
          const message = String(e?.message ?? e);
          results.push({ ...base, status: 'failed', message });
          if (flags.verbose && !this.jsonEnabled()) this.log(`[failed] ${job.project}: ${message}`);
          // A dead session will fail every remaining row; stop instead.
          if (e?.reason === 'redirected_to_login') {
            this.warn('Session expired; stopping. Log in again and re-run the remaining rows.');
            break;
          }
        }
        progress?.update(index + 1, counts());
      }
    } finally {
      progress?.stop();
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      await browserManager.closeBrowser();
      writeCsv();
    }

    if (this.jsonEnabled()) return payload(false);
    if (flags['output-csv']) this.log(`Saved results CSV to ${flags['output-csv']}`);
    const c = counts();
    this.log(
      dryRun
        ? `Dry run complete. Would update: ${c.dryRun}, Unchanged: ${c.unchanged}, Failed: ${c.failed}`
        : `Completed. Updated: ${c.updated}, Unchanged: ${c.unchanged}, Failed: ${c.failed}`,
    );
    if (c.failed) {
      for (const r of results.filter((r) => r.status === 'failed')) {
        this.log(`  Row ${r.row} ${r.project}: ${r.message}`);
      }
      process.exitCode = 1;
    }
    return undefined;
  }
}
