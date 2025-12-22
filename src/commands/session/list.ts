import { Command, Flags } from '@oclif/core';
import { printTable } from '@oclif/table';
import * as db from '../../lib/db.js';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import type { SessionRow } from '../../lib/db.js';

export default class SessionList extends Command {
  static override description = 'list open e-Builder sessions';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --username myuser',
    '<%= config.bin %> <%= command.id %> --json',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'username to filter sessions by',
    }),
  };

  public async run(): Promise<any> {
    const { flags } = await this.parse(SessionList);

    let sessions: SessionRow[];
    if (flags.username) {
      sessions = db.getSessionsByUsername(flags.username) as SessionRow[];
    } else {
      sessions = db.getSessions() as SessionRow[];
    }

    if (sessions.length === 0) {
      if (this.jsonEnabled()) {
        return [];
      }
      this.log('No sessions found.');
      return;
    }

    if (this.jsonEnabled()) {
      const jsonSessions = sessions.map((session) => ({
        id: session.id,
        username: session.username,
        environment: session.environment,
        account: session.account,
        created_at: session.created_at,
      }));
      return jsonSessions;
    } else {
      const data = sessions.map((s) => ({
        id: s.id,
        username: s.username,
        environment: eb.getDisplayName(s.environment),
        account: s.account,
        createdAt: new Date(s.created_at + 'Z').toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        }),
      }));

      printTable({
        title: 'Open Sessions',
        data,
        columns: [
          { key: 'id', name: 'ID' },
          { key: 'username', name: 'Username' },
          { key: 'environment', name: 'Environment' },
          { key: 'account', name: 'Account' },
          { key: 'createdAt', name: 'Created At' },
        ],
      });
    }
  }
}
