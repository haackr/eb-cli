import { Command, Flags } from "@oclif/core";
import { select, input } from "@inquirer/prompts";
import { type Cookie } from "puppeteer";
import ora from "ora";
import * as eb from "../lib/eb-puppetmaster/auth.js";
import * as db from "../lib/db.js";

type SessionRow = {
  id: number;
  username: string;
  environment: string;
  account: string;
  session_cookies: string;
  created_at: string;
};

export default class Logout extends Command {
  static override description = "log out of e-Builder sessions";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
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
  };
  static override aliases: string[] = ["session:delete"];

  public async run(): Promise<void> {
    const { flags } = await this.parse(Logout);

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
        name: `${session.username} - ${session.environment} - ${session.account}`,
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
      return;
    } else {
      // Logout from the selected session
      if (!selectedSession) throw new Error("No session selected");
      await this.logoutSession(selectedSession, !flags.show_browser);
    }
  }

  private async logoutSession(
    session: SessionRow,
    show_browser: boolean
  ): Promise<boolean> {
    let env: eb.Environment;
    switch (session.environment) {
      case "app":
        env = eb.Environment.US1;
        break;
      case "app-us2":
        env = eb.Environment.US2;
        break;
      case "app-us3":
        env = eb.Environment.US3;
        break;
      case "app-us4":
        env = eb.Environment.US4;
        break;
      case "gov":
        env = eb.Environment.GOV;
        break;
      case "app.ca":
        env = eb.Environment.CA;
        break;
      default:
        throw new Error(`Unknown environment: ${session.environment}`);
    }

    const cookies: Cookie[] = JSON.parse(session.session_cookies);

    const spinner = ora(
      `Logging out of account ${session.username} - ${session.environment} - ${session.account}...`
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
