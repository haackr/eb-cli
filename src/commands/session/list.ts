import { Command, Flags } from "@oclif/core";
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

export default class SessionList extends Command {
  static override description = "list open e-Builder sessions";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --username myuser",
  ];
  static override flags = {
    username: Flags.string({
      char: "u",
      description: "username to filter sessions by",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(SessionList);

    let sessions: SessionRow[];
    if (flags.username) {
      sessions = db.getSessionsByUsername(flags.username) as SessionRow[];
    } else {
      sessions = db.getSessions() as SessionRow[];
    }

    if (sessions.length === 0) {
      this.log("No sessions found.");
      return;
    }

    this.log("Open Sessions:");
    this.log("ID | Username | Environment | Account | Created At | Expires At");
    this.log(
      "---|----------|-------------|---------|------------|------------"
    );
    for (const session of sessions) {
      const expiresAt = session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : "N/A";
      this.log(
        `${session.id} | ${session.username} | ${session.environment} | ${session.account} | ${session.created_at} | ${expiresAt}`
      );
    }
  }
}
