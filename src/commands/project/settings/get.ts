import { Args } from '@oclif/core';
import * as eb from '../../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../../lib/base-session-command.js';
import {
  formatSettingValue,
  getProjectSettings,
  PROJECT_SETTING_KEYS,
  PROJECT_SETTING_LABELS,
  type ProjectSettingsResult,
} from '../../../lib/eb-puppetmaster/project-settings.js';

export default class ProjectSettingsGet extends BaseSessionCommand {
  static override summary = "Show a project's settings (Project Details → Settings tab)";
  static override description =
    'Reads Project Access, Deny Techsupport Access, Enable Document Control, Workflow Due Date Offset, Work Day Start/End Time and Work Week. Settings that are hidden or read-only for the project are listed as unavailable.';
  static override examples = [
    '<%= config.bin %> <%= command.id %> "RH - eB-CLI Test project"',
    '<%= config.bin %> <%= command.id %> 9869854c-4c8d-4638-8b5e-e52d08103c12 --json',
  ];
  static override enableJsonFlag = true;
  static override args = {
    project: Args.string({
      description: 'Exact project name (case-insensitive) or PortalID GUID',
      required: true,
    }),
  };
  static override flags = {
    ...BaseSessionCommand.baseFlags,
  };

  public async run(): Promise<ProjectSettingsResult> {
    const { args, flags } = await this.parse(ProjectSettingsGet);
    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    try {
      const result = await this.withSessionCookies(session.id, !flags['show-browser'], (cookies) =>
        getProjectSettings({ env, cookies, project: args.project }),
      );
      if (!this.jsonEnabled()) {
        this.log(`${result.project.name} (${result.project.id})`);
        const width = Math.max(...Object.values(PROJECT_SETTING_LABELS).map((l) => l.length));
        for (const key of PROJECT_SETTING_KEYS) {
          const value = result.unavailable.includes(key)
            ? '(unavailable)'
            : formatSettingValue(result.settings[key]);
          this.log(`  ${PROJECT_SETTING_LABELS[key].padEnd(width)}  ${value}`);
        }
      }
      return result;
    } finally {
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }
}
