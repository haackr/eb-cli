import { Args, Command, Flags } from "@oclif/core";
import { select } from "@inquirer/prompts";
import * as fs from "fs";
import Papa from "papaparse";
import ora from "ora";
import * as eb from "../../lib/eb-puppetmaster/index.js";
import * as db from "../../lib/db.js";
import { promptLoginAndSaveSession } from "../../lib/login-helper.js";

type SessionRow = {
  id: number;
  username: string;
  environment: string;
  account: string;
  session_cookies: string;
  created_at: string;
};

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
    "show-browser": Flags.boolean({
      char: "s",
      description: "Show browser window",
    }),
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
        await promptLoginAndSaveSession({ showBrowser: flags["show-browser"] });
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
    const items = parsed.data as { budgetItemId: string }[];

    // Get environment
    const env = eb.getEnvironment(session.environment);

    const cookies = JSON.parse(session.session_cookies);

    // Delete each item
    const browser = await eb.BrowserManager.getInstance().getBrowser();
    for (const item of items) {
      if (!item.budgetItemId) continue;
      const spinner = ora(`Deleting budget item ${item.budgetItemId}`).start();
      try {
        await eb.deleteBudgetItem({
          env,
          cookies,
          browser,
          budgetItem: { budgetItemId: item.budgetItemId },
        });
        spinner.succeed(`Deleted budget item ${item.budgetItemId}`);
      } catch (e: any) {
        spinner.fail(`Failed to delete ${item.budgetItemId}: ${e.message}`);
      }
    }

    // Close browser
    await eb.BrowserManager.getInstance().closeBrowser();
  }
}
