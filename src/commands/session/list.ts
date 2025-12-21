import { Command, Flags } from "@oclif/core";
import Table from "cli-table3";
import * as db from "../../lib/db.js";
import * as eb from "../../lib/eb-puppetmaster/index.js";
import type { SessionRow } from "../../lib/db.js";

export default class SessionList extends Command {
  static override description = "list open e-Builder sessions";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --username myuser",
    "<%= config.bin %> <%= command.id %> --json",
  ];
  static override flags = {
    username: Flags.string({
      char: "u",
      description: "username to filter sessions by",
    }),
    json: Flags.boolean({
      description: "output sessions as JSON",
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
      if (flags.json) {
        this.log(JSON.stringify([]));
      } else {
        this.log("No sessions found.");
      }
      return;
    }

    if (flags.json) {
      const jsonSessions = sessions.map((session) => ({
        id: session.id,
        username: session.username,
        environment: session.environment,
        account: session.account,
        created_at: session.created_at,
      }));
      this.log(JSON.stringify(jsonSessions, null, 2));
    } else {
      const table = new Table({
        head: ["ID", "Username", "Environment", "Account", "Created At"],
        style: {
          head: ["cyan"],
          border: ["gray"],
        },
      });

      for (const session of sessions) {
        table.push([
          session.id,
          session.username,
          eb.getDisplayName(session.environment),
          session.account,
          new Date(session.created_at + "Z").toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short",
          }),
        ]);
      }

      this.log("Open Sessions:");
      this.log(table.toString());
    }
  }
}
