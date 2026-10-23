import { Command, Flags } from '@oclif/core';
import type { Cookie } from 'puppeteer';
import ora from 'ora';
import * as eb from '../../lib/eb-puppetmaster/index.js';
import * as db from '../../lib/db.js';
import type { SessionRow } from '../../lib/db.js';

export interface SessionTestOutput {
  id: number;
  username: string;
  environment: string;
  account: string;
  valid: boolean;
  refreshed: boolean;
  deleted: boolean;
  error: string | null;
}

export default class SessionTest extends Command {
  static override description =
    'test e-Builder sessions, refresh valid ones, and remove invalid ones';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --username myuser',
    '<%= config.bin %> <%= command.id %> --show-browser',
    '<%= config.bin %> <%= command.id %> --no-delete --json',
  ];
  static override enableJsonFlag = true;
  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'username to test sessions for (tests all if not specified)',
    }),
    show_browser: Flags.boolean({
      char: 's',
      description: 'show browser window during testing',
    }),
    delete: Flags.boolean({
      description: 'delete invalid sessions from database',
      default: true,
      allowNo: true,
    }),
  };
  static override aliases: string[] = ['session:clean'];

  public async run(): Promise<SessionTestOutput[] | void> {
    const { flags } = await this.parse(SessionTest);

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
      this.log('No sessions found to test.');
      return;
    }

    if (!this.jsonEnabled()) {
      this.log(`Testing ${sessions.length} session(s)...`);
    }

    const results: SessionTestOutput[] = [];
    const invalidSessions: SessionRow[] = [];

    for (const session of sessions) {
      const spinner = this.jsonEnabled()
        ? null
        : ora(
            `Testing session for ${session.username} (${eb.getDisplayName(
              session.environment,
            )}/${session.account})`,
          ).start();

      const env = eb.getEnvironment(session.environment);
      const cookies: Cookie[] = JSON.parse(session.session_cookies);

      try {
        const { isLoggedIn, newCookies } = await eb.isLoggedIn(env, !flags.show_browser, cookies);
        if (isLoggedIn) {
          db.updateSessionById(
            session.id,
            session.username,
            session.environment,
            session.account,
            JSON.stringify(newCookies),
          );
          if (spinner) {
            spinner.succeed(`Session valid and refreshed`);
          }
          results.push({
            id: session.id,
            username: session.username,
            environment: session.environment,
            account: session.account,
            valid: true,
            refreshed: true,
            deleted: false,
            error: null,
          });
        } else {
          if (spinner) {
            spinner.fail(`Session invalid`);
          }
          invalidSessions.push(session);
          results.push({
            id: session.id,
            username: session.username,
            environment: session.environment,
            account: session.account,
            valid: false,
            refreshed: false,
            deleted: false,
            error: 'Session invalid or cookies expired',
          });
        }
      } catch (e: any) {
        if (spinner) {
          spinner.fail(`Error testing session: ${e.message}`);
        }
        invalidSessions.push(session);
        results.push({
          id: session.id,
          username: session.username,
          environment: session.environment,
          account: session.account,
          valid: false,
          refreshed: false,
          deleted: false,
          error: e.message || 'Unknown error testing session',
        });
      }
    }

    const shouldDelete = flags.delete !== false;

    if (invalidSessions.length > 0) {
      if (shouldDelete) {
        if (!this.jsonEnabled()) {
          this.log(`\nRemoving ${invalidSessions.length} invalid session(s)...`);
        }
        for (const session of invalidSessions) {
          db.deleteSessionById(session.id);
          const res = results.find((r) => r.id === session.id);
          if (res) res.deleted = true;

          if (!this.jsonEnabled()) {
            this.log(
              `Removed session: ${session.username} (${eb.getDisplayName(
                session.environment,
              )}/${session.account})`,
            );
          }
        }
      } else if (!this.jsonEnabled()) {
        this.log(
          `\nFound ${invalidSessions.length} invalid session(s) (retained due to --no-delete).`,
        );
      }
    } else if (!this.jsonEnabled()) {
      this.log('\nAll sessions are valid.');
    }

    await eb.BrowserManager.getInstance().closeBrowser();

    if (this.jsonEnabled()) {
      return results;
    }
  }
}
