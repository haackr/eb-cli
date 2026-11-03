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
  /** Why the check concluded what it did; only `redirected_to_login` means the cookies are dead. */
  reason: eb.SessionCheckReason;
  error: string | null;
}

export default class SessionTest extends Command {
  static override description =
    'test e-Builder sessions and refresh valid ones. With --delete, removes sessions that were redirected to a login page (network errors, timeouts, and server errors never delete a session).';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --username myuser',
    '<%= config.bin %> <%= command.id %> --show-browser',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --delete',
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
      char: 'd',
      description:
        'delete sessions whose cookies were rejected (redirected to login). Never deletes on network/timeout/server errors.',
      default: false,
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
    const expiredSessions: SessionRow[] = [];

    for (const session of sessions) {
      const label = `${session.username} (${eb.getDisplayName(session.environment)}/${session.account})`;
      const spinner = this.jsonEnabled() ? null : ora(`Testing session for ${label}`).start();

      const env = eb.getEnvironment(session.environment);
      const cookies: Cookie[] = JSON.parse(session.session_cookies);
      const base = {
        id: session.id,
        username: session.username,
        environment: session.environment,
        account: session.account,
        deleted: false,
      };

      let check: eb.SessionCheckResult;
      try {
        check = await eb.isLoggedIn(env, !flags.show_browser, cookies);
      } catch (e: any) {
        check = {
          isLoggedIn: false,
          reason: eb.classifyNavigationError(e) ?? 'unknown',
          errorMessage: e?.message || 'Unknown error testing session',
          newCookies: [],
        };
      }

      if (check.isLoggedIn) {
        db.updateSessionById(
          session.id,
          session.username,
          session.environment,
          session.account,
          JSON.stringify(check.newCookies),
        );
        spinner?.succeed('Session valid and refreshed');
        results.push({ ...base, valid: true, refreshed: true, reason: check.reason, error: null });
        continue;
      }

      const err = eb.sessionCheckErrorFor(check, `https://${env}.${eb.baseurl}`);
      if (check.reason === 'redirected_to_login') {
        expiredSessions.push(session);
        spinner?.fail('Session expired (redirected to login)');
      } else {
        spinner?.warn(`Session could not be verified: ${err.message}`);
      }
      results.push({
        ...base,
        valid: false,
        refreshed: false,
        reason: check.reason,
        error: err.message,
      });
    }

    const unverified = results.filter((r) => !r.valid && r.reason !== 'redirected_to_login');

    if (expiredSessions.length > 0) {
      if (flags.delete) {
        if (!this.jsonEnabled()) {
          this.log(`\nRemoving ${expiredSessions.length} expired session(s)...`);
        }
        for (const session of expiredSessions) {
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
          `\nFound ${expiredSessions.length} expired session(s). Re-run with --delete to remove them, or 'eb login' to re-authenticate.`,
        );
      }
    }

    if (!this.jsonEnabled()) {
      if (unverified.length > 0) {
        this.log(
          `\n${unverified.length} session(s) could not be verified (network/timeout/server error) and were left untouched.`,
        );
      } else if (expiredSessions.length === 0) {
        this.log('\nAll sessions are valid.');
      }
    }

    await eb.BrowserManager.getInstance().closeBrowser();

    if (this.jsonEnabled()) {
      return results;
    }
  }
}
