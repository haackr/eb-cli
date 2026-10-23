import { Flags } from '@oclif/core';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import { BaseSessionCommand } from '../../lib/base-session-command.js';
import {
  fetchReportCatalog,
  getCachedReportCatalog,
  type ReportSummaryItem,
} from '../../lib/eb-puppetmaster/report.js';

export default class ReportsList extends BaseSessionCommand {
  static override description = 'list available standard and custom e-Builder reports with caching';
  static override examples = [
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --category Process --json',
    '<%= config.bin %> <%= command.id %> --search "Change Order" --refresh',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['reports:catalog'];

  static override flags = {
    ...BaseSessionCommand.baseFlags,
    category: Flags.string({
      char: 'c',
      description: 'Filter reports by category name',
    }),
    search: Flags.string({
      char: 'q',
      description: 'Filter reports by search keyword in name or description',
    }),
    cached: Flags.boolean({
      description: 'Use locally cached report catalog from SQLite if available (default: true)',
      default: true,
      allowNo: true,
    }),
    refresh: Flags.boolean({
      description: 'Force live refresh from e-Builder and update cache',
      default: false,
    }),
  };

  public async run(): Promise<ReportSummaryItem[] | void> {
    const { flags } = await this.parse(ReportsList);

    const session = await this.getSession(flags);
    const env = eb.getEnvironment(session.environment);
    const useCache = flags.cached && !flags.refresh;

    let items: ReportSummaryItem[] | undefined;

    if (useCache) {
      items = getCachedReportCatalog(session.environment, session.account);
    }

    if (!items) {
      const headless = !flags['show-browser'];
      const cookies = await this.getSessionCookies(session.id, headless);

      try {
        items = await fetchReportCatalog({
          env,
          cookies,
          account: session.account,
          useCache: false,
        });
      } finally {
        await eb.BrowserManager.getInstance().closeBrowser();
      }
    }

    if (flags.category) {
      const cat = flags.category.toLowerCase();
      items = items.filter((r) => r.category.toLowerCase().includes(cat));
    }

    if (flags.search) {
      const q = flags.search.toLowerCase();
      items = items.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.description && r.description.toLowerCase().includes(q)),
      );
    }

    if (this.jsonEnabled()) {
      return items;
    }

    this.log(JSON.stringify(items, null, 2));
  }
}
