import { Args, Command, Flags } from "@oclif/core";
import { select } from "@inquirer/prompts";
import * as fs from "fs";
import Papa from "papaparse";
import ora from "ora";
import * as eb from "../../lib/eb-puppetmaster/index.js";
import * as db from "../../lib/db.js";
import type { SessionRow } from "../../lib/db.js";
import {
  promptLoginAndSaveSession,
  refreshSessionIfNeeded,
} from "../../lib/login-helper.js";

export default class BudgetitemsDelete extends Command {
  static override args = {
    file: Args.string({
      description: "CSV file containing budget item IDs to delete",
      required: true,
    }),
  };
  static override description = "Delete budget items from a CSV file";
  static override examples = [
    "<%= config.bin %> <%= command.id %> items.csv --session-id 1",
    "<%= config.bin %> <%= command.id %> items.csv --username myuser",
  ];
  static override flags = {
    "session-id": Flags.integer({ description: "Session ID to use" }),
    username: Flags.string({
      char: "u",
      description: "Username to use session for",
    }),
    show_browser: Flags.boolean({
      char: "s",
      description: "Show browser window",
    }),
    "dry-run": Flags.boolean({ description: "Dry run (no actual deletion)" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(BudgetitemsDelete);

    // Get session
    let session: SessionRow | undefined;
    if (flags["session-id"]) {
      session = db.getSessionById(flags["session-id"]) as SessionRow;
      if (!session) {
        this.error(`Session with ID ${flags["session-id"]} not found.`);
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
          message: "Select a session:",
          choices,
        });
      }
    } else {
      // No session specified, check if any sessions exist
      const allSessions = db.getSessions() as SessionRow[];
      if (allSessions.length === 0) {
        // No sessions, prompt to login
        this.log("No open sessions found. Please log in first.");
        await promptLoginAndSaveSession({ showBrowser: flags.show_browser });
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
            message: "Select a session:",
            choices,
          });
        }
      } else if (allSessions.length === 1) {
        session = allSessions[0];
      } else {
        // Prompt to select
        const choices = allSessions.map((s) => ({
          name: `${s.username} (${s.environment}/${s.account}) - ${s.created_at}`,
          value: s,
        }));
        session = await select({
          message: "Select a session:",
          choices,
        });
      }
    }

    if (!session) {
      this.error("No session selected.");
    }

    // Parse CSV
    const csvData = fs.readFileSync(args.file, "utf8");
    const parsed = Papa.parse(csvData, { header: true, skipEmptyLines: true });
    if (parsed.errors.length > 0) {
      this.error(
        `CSV parsing errors: ${parsed.errors.map((e) => e.message).join(", ")}`
      );
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

    let cookies = JSON.parse(session.session_cookies);

    // Check and refresh session
    if (!(await refreshSessionIfNeeded(session.id, !flags.show_browser))) {
      this.error("Session has expired. Please log in again using 'eb login'.");
    }
    // Re-parse cookies after refresh
    const refreshedSession = db.getSessionById(session.id) as SessionRow;
    cookies = JSON.parse(refreshedSession.session_cookies);

    // Delete each item
    const browser = await eb.BrowserManager.getInstance().getBrowser(
      !flags.show_browser,
      !flags.show_browser ? ["--window-size=1200,800"] : undefined
    );

    let refreshCounter = 0;
    for (const item of items) {
      if (!item.itemId) continue;

      // Refresh session every 10 items
      if (refreshCounter % 10 === 0) {
        if (!(await refreshSessionIfNeeded(session.id, !flags.show_browser))) {
          this.error(
            "Session has expired during operation. Please log in again using 'eb login'."
          );
        }
        const refreshedSession2 = db.getSessionById(session.id) as SessionRow;
        cookies = JSON.parse(refreshedSession2.session_cookies);
      }

      const spinner = ora(`Deleting budget item ${item.itemId}`).start();
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
          dryRun: flags["dry-run"],
        });
        spinner.succeed(`Deleted budget item ${item.itemId}`);
      } catch (e: any) {
        spinner.fail(`Failed to delete ${item.itemId}: ${e.message}`);
      }
      refreshCounter++;
    }

    // Close browser
    await eb.BrowserManager.getInstance().closeBrowser();
  }
}
