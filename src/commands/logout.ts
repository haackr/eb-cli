import { Command, Flags } from "@oclif/core";
import { select, input } from "@inquirer/prompts";
import { type Cookie } from "puppeteer";
import ora from "ora";
import * as eb from "../lib/eb-puppetmaster/index.js";
import * as db from "../lib/db.js";

type SessionRow = {
  id: number;
  username: string;
  environment: string;
  account: string;
  session_cookies: string;
  created_at: string;
  expires_at: number | null;
};

export default class Logout extends Command {
  static override description = "log out of e-Builder sessions";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --session-id 1",
    "<%= config.bin %> <%= command.id %> --username john.doe",
    "<%= config.bin %> <%= command.id %> --all",
  ];
  static override flags = {
    show_browser: Flags.boolean({
      char: "s",
      description:
        "show browser window (useful for debugging; default is headless)",
    }),
    username: Flags.string({ char: "u", description: "username" }),
    account: Flags.string({
      char: "a",
      description: "account (if the user has access to multiple accounts)",
    }),
    all: Flags.boolean({ char: "A", description: "logout from all sessions" }),
    session_id: Flags.integer({
      char: "i",
      description: "session ID to logout from",
    }),
  };
  static override aliases: string[] = ["session:delete"];

  public async run(): Promise<void> {
    const { flags } = await this.parse(Logout);

    if (flags.session_id) {
      const session = db.getSessionById(flags.session_id) as
        | SessionRow
        | undefined;
      if (!session) {
        this.log(`No session found with ID ${flags.session_id}.`);
        return;
      }
      await this.logoutSession(session, !flags.show_browser);
      // Close the browser to allow the process to exit
      await eb.BrowserManager.getInstance().closeBrowser();
      return;
    }

    let username = flags.username;
    let sessions: SessionRow[] = [];

    if (username) sessions = db.getSessionsByUsername(username) as SessionRow[];
    if (!username) sessions = db.getSessions() as SessionRow[];
    if (sessions.length === 0) {
      this.log(`No sessions found${username ? ` for ${username}` : ""}.`);
      return;
    }

    let selectedSession: SessionRow | undefined;
    if (sessions.length === 1) {
      selectedSession = sessions[0]!;
    } else if (!flags.all) {
      // Prompt to select which session to logout
      const choices = sessions.map((session) => ({
        name: `${session.username} - ${eb.getDisplayName(
          session.environment
        )} - ${session.account}`,
        value: session,
      }));
      selectedSession = await select({
        message: "Select the session to log out from:",
        choices,
      });
    }

    if (flags.all) {
      // Logout from all sessions
      for (const session of sessions) {
        await this.logoutSession(session, !flags.show_browser);
      }
      // Close the browser to allow the process to exit
      await eb.BrowserManager.getInstance().closeBrowser();
      return;
    } else {
      // Logout from the selected session
      if (!selectedSession) throw new Error("No session selected");
      await this.logoutSession(selectedSession, !flags.show_browser);
      // Close the browser to allow the process to exit
      await eb.BrowserManager.getInstance().closeBrowser();
    }
  }

  private async logoutSession(
    session: SessionRow,
    show_browser: boolean
  ): Promise<boolean> {
    const env = eb.getEnvironment(session.environment);

    const cookies: Cookie[] = JSON.parse(session.session_cookies);

    const spinner = ora(
      `Logging out of account ${session.username} - ${eb.getDisplayName(
        session.environment
      )} - ${session.account}...`
    ).start();
    try {
      await eb.logout(env, show_browser, cookies);
    } catch (e: any) {
      spinner.fail(`Failed to log out: ${e.message}`);
      return false;
    }
    spinner.succeed("Logged out successfully!");
    db.deleteSessionById(session.id);
    return true;
  }
}
