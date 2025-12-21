import { Command, Flags } from "@oclif/core";
import puppeteer, { type Cookie } from "puppeteer";
import ora from "ora";
import * as eb from "../../lib/eb-puppetmaster/auth.js";
import * as db from "../../lib/db.js";

type SessionRow = {
  id: number;
  username: string;
  environment: string;
  account: string;
  session_cookies: string;
  created_at: string;
  expires_at: number | null;
};

export default class SessionTest extends Command {
  static override description =
    "test e-Builder sessions, refresh valid ones, and remove invalid ones";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --username myuser",
  ];
  static override flags = {
    username: Flags.string({
      char: "u",
      description: "username to test sessions for (tests all if not specified)",
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
        `Testing session for ${session.username} (${session.environment}/${session.account})`
      ).start();

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
          spinner.fail(`Unknown environment: ${session.environment}`);
          continue;
      }

      const cookies: Cookie[] = JSON.parse(session.session_cookies);

      try {
        const { isLoggedIn, newCookies } = await eb.isLoggedIn(
          env,
          true,
          cookies
        );
        if (isLoggedIn) {
          // Update session with new cookies
          let newExpiresAt: number | null = null;
          for (const cookie of newCookies) {
            if (cookie.expires !== undefined && cookie.expires !== -1) {
              if (newExpiresAt === null || cookie.expires < newExpiresAt) {
                newExpiresAt = cookie.expires;
              }
            }
          }
          db.updateSessionById(
            session.id,
            session.username,
            session.environment,
            session.account,
            JSON.stringify(newCookies),
            newExpiresAt
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
          `Removed session: ${session.username} (${session.environment}/${session.account})`
        );
      }
    } else {
      this.log("\nAll sessions are valid.");
    }
  }
}
