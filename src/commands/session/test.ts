import { Command, Flags } from "@oclif/core";
import puppeteer, { type Cookie } from "puppeteer";
import ora from "ora";
import * as eb from "../../lib/eb-puppetmaster/index.js";
import * as db from "../../lib/db.js";
import type { SessionRow } from "../../lib/db.js";

export default class SessionTest extends Command {
  static override description =
    "test e-Builder sessions, refresh valid ones, and remove invalid ones";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --username myuser",
    "<%= config.bin %> <%= command.id %> --show-browser",
  ];
  static override flags = {
    username: Flags.string({
      char: "u",
      description: "username to test sessions for (tests all if not specified)",
    }),
    show_browser: Flags.boolean({
      char: "s",
      description: "show browser window during testing",
    }),
  };
  static override aliases: string[] = ["session:clean"];

  public async run(): Promise<void> {
    const { flags } = await this.parse(SessionTest);

    let sessions: SessionRow[];
    if (flags.username) {
      sessions = db.getSessionsByUsername(flags.username) as SessionRow[];
    } else {
      sessions = db.getSessions() as SessionRow[];
    }

    if (sessions.length === 0) {
      this.log("No sessions found to test.");
      return;
    }

    this.log(`Testing ${sessions.length} session(s)...`);

    const invalidSessions: SessionRow[] = [];

    for (const session of sessions) {
      const spinner = ora(
        `Testing session for ${session.username} (${eb.getDisplayName(
          session.environment
        )}/${session.account})`
      ).start();

      const env = eb.getEnvironment(session.environment);

      const cookies: Cookie[] = JSON.parse(session.session_cookies);

      try {
        const { isLoggedIn, newCookies } = await eb.isLoggedIn(
          env,
          !flags.show_browser,
          cookies
        );
        if (isLoggedIn) {
          // Update session with new cookies
          db.updateSessionById(
            session.id,
            session.username,
            session.environment,
            session.account,
            JSON.stringify(newCookies)
          );
          spinner.succeed(`Session valid and refreshed`);
        } else {
          spinner.fail(`Session invalid`);
          invalidSessions.push(session);
        }
      } catch (e: any) {
        spinner.fail(`Error testing session: ${e.message}`);
        invalidSessions.push(session);
      }
    }

    if (invalidSessions.length > 0) {
      this.log(`\nRemoving ${invalidSessions.length} invalid session(s)...`);
      for (const session of invalidSessions) {
        db.deleteSessionById(session.id);
        this.log(
          `Removed session: ${session.username} (${eb.getDisplayName(
            session.environment
          )}/${session.account})`
        );
      }
    } else {
      this.log("\nAll sessions are valid.");
    }

    // Close the browser to allow the process to exit
    await eb.BrowserManager.getInstance().closeBrowser();
  }
}
