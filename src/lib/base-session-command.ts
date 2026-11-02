import { Command, Flags } from '@oclif/core';
import { select } from '@inquirer/prompts';
import * as eb from './eb-puppetmaster/index.js';
import * as db from './db.js';
import type { SessionRow } from './db.js';
import { promptLoginAndSaveSession, refreshSessionIfNeeded } from './login-helper.js';

/**
 * Base command class for commands that require e-Builder session management.
 * Provides common session resolution, selection, and refresh functionality.
 */
export abstract class BaseSessionCommand extends Command {
  /**
   * Common flags that all session commands use.
   * Extend these in subclasses with command-specific flags.
   */
  static override baseFlags = {
    'session-id': Flags.integer({ char: 'i', description: 'Session ID to use' }),
    username: Flags.string({
      char: 'u',
      description: 'Username to use session for',
    }),
    account: Flags.string({
      char: 'A',
      description:
        'Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme - Production")',
    }),
    'show-browser': Flags.boolean({
      char: 's',
      description: 'Show browser window',
    }),
  };

  /**
   * Determine if the command is running interactively.
   * If non-TTY or --json is passed, the command operates non-interactively without prompting.
   */
  protected isInteractive(): boolean {
    let hasJsonFlag = false;
    try {
      hasJsonFlag = typeof this.jsonEnabled === 'function' ? this.jsonEnabled() : false;
    } catch {
      hasJsonFlag = false;
    }
    return Boolean(process.stdout.isTTY && !hasJsonFlag);
  }

  /**
   * Resolve and return a session based on flags or user selection.
   * Handles session lookup by ID, username, or interactive selection.
   * Will prompt for login if no sessions exist (in interactive mode).
   *
   * @param flags - Command flags containing session-id, username, and show-browser
   * @returns The resolved SessionRow
   */
  protected async getSession(flags: {
    'session-id'?: number | undefined;
    username?: string | undefined;
    account?: string | undefined;
    'show-browser'?: boolean | undefined;
  }): Promise<SessionRow> {
    let session: SessionRow | undefined;

    if (flags['session-id']) {
      session = db.getSessionById(flags['session-id']) as SessionRow;
      if (!session) {
        this.error(`Session with ID ${flags['session-id']} not found.`);
      }
    } else if (flags.username || flags.account) {
      const sessions = this.filterSessions(flags.username, flags.account);
      if (sessions.length === 1) {
        session = sessions[0];
      } else if (!this.isInteractive()) {
        session = [...sessions].sort((a, b) => b.id - a.id)[0];
      } else {
        session = await this.selectSession(sessions);
      }
    } else {
      session = await this.getOrCreateSession(flags['show-browser']);
    }

    if (!session) {
      this.error('No session selected.');
    }

    return session;
  }

  /**
   * Filters stored sessions by username (exact) and/or account (case-insensitive substring;
   * exact account-name matches win over substring matches). Errors with the available
   * accounts when nothing matches.
   */
  private filterSessions(username?: string, account?: string): SessionRow[] {
    let sessions = (
      username ? db.getSessionsByUsername(username) : db.getSessions()
    ) as SessionRow[];
    if (username && sessions.length === 0) {
      this.error(`No sessions found for username ${username}.`);
    }

    if (account) {
      const needle = account.trim().toLowerCase();
      const exact = sessions.filter((s) => (s.account ?? '').trim().toLowerCase() === needle);
      const partial = sessions.filter((s) => (s.account ?? '').toLowerCase().includes(needle));
      const matches = exact.length > 0 ? exact : partial;
      if (matches.length === 0) {
        const available = [...new Set(sessions.map((s) => `"${s.account}" (id ${s.id})`))];
        this.error(
          `No sessions found matching account "${account}"${
            username ? ` for username ${username}` : ''
          }. Available: ${available.length ? available.join(', ') : 'none'}.`,
        );
      }
      sessions = matches;
    }

    return sessions;
  }

  /**
   * Prompt user to select from multiple sessions using an interactive menu.
   *
   * @param sessions - Array of sessions to choose from
   * @returns The selected SessionRow
   */
  private async selectSession(sessions: SessionRow[]): Promise<SessionRow> {
    const choices = sessions.map((s) => ({
      name: `${s.username} (${eb.getDisplayName(s.environment)}/${s.account}) - ${s.created_at}`,
      value: s,
    }));
    return await select({
      message: 'Select a session:',
      choices,
    });
  }

  /**
   * Get an existing session or prompt user to login if none exist.
   * If multiple sessions exist, prompts user to select one (or picks latest non-interactively).
   *
   * @param showBrowser - Whether to show the browser during login
   * @returns The selected or newly created SessionRow
   */
  private async getOrCreateSession(showBrowser?: boolean | undefined): Promise<SessionRow> {
    const allSessions = db.getSessions() as SessionRow[];

    if (allSessions.length === 0) {
      if (!this.isInteractive()) {
        this.error(
          "No active e-Builder sessions found. Please authenticate first using 'eb session import' or 'eb login'.",
        );
      }
      this.log('No open sessions found. Please log in first.');
      await promptLoginAndSaveSession({ showBrowser: showBrowser ?? false });
      const newSessions = db.getSessions() as SessionRow[];
      if (newSessions.length === 0) {
        this.error('Failed to create session.');
      }
      return newSessions.length === 1 ? newSessions[0]! : await this.selectSession(newSessions);
    }

    if (allSessions.length === 1) {
      return allSessions[0]!;
    }

    if (!this.isInteractive()) {
      return [...allSessions].sort((a, b) => b.id - a.id)[0]!;
    }

    return await this.selectSession(allSessions);
  }

  /**
   * Get session cookies, refreshing the session if needed.
   *
   * Throws a typed error when the session cannot be used. Only an actual redirect to a login
   * page is reported as an expired session; network, timeout, and server errors are reported
   * as such (with the stored cookies left untouched) so they are not mistaken for logouts.
   *
   * @param sessionId - The session ID to get cookies for
   * @param headless - Whether to run the refresh in headless mode (default: true)
   * @param options.skipRefresh - Return stored cookies without a pre-flight browser check.
   *   Use when the caller verifies authentication itself (e.g. `eb exec`).
   * @returns Parsed session cookies array
   */
  protected async getSessionCookies(
    sessionId: number,
    headless: boolean = true,
    options: { skipRefresh?: boolean } = {},
  ): Promise<any[]> {
    if (options.skipRefresh) {
      const stored = db.getSessionById(sessionId) as SessionRow | undefined;
      if (!stored?.session_cookies) {
        this.error(
          `No cookies found for session ${sessionId}. Please log in again using 'eb login'.`,
        );
      }
      return JSON.parse(stored.session_cookies);
    }

    const check = await refreshSessionIfNeeded(sessionId, headless);
    if (check.isLoggedIn) {
      const session = db.getSessionById(sessionId) as SessionRow;
      return JSON.parse(session.session_cookies);
    }

    if (check.reason === 'redirected_to_login' || check.reason === 'unknown') {
      const reloggedCookies = await this.reloginWithCredentialProvider(sessionId, headless);
      if (reloggedCookies) return reloggedCookies;
    }

    const session = db.getSessionById(sessionId) as SessionRow | undefined;
    const origin = session
      ? `https://${eb.getEnvironment(session.environment)}.${eb.baseurl}`
      : 'e-Builder';
    const err = eb.sessionCheckErrorFor(check, origin);
    this.error(err.message, { code: err.code });
  }

  /**
   * If the session has an autonomous credential reference (1Password, Bitwarden, etc.),
   * performs a fresh login, persists the new cookies, and returns them. Returns null otherwise.
   */
  protected async reloginWithCredentialProvider(
    sessionId: number,
    headless: boolean = true,
  ): Promise<any[] | null> {
    const credRef = db.getCredentialRef(sessionId);
    if (!credRef) return null;
    const session = db.getSessionById(sessionId) as SessionRow | undefined;
    if (!session) return null;
    try {
      const { CredentialResolver } = await import('./credentials/resolver.js');
      const creds = await CredentialResolver.resolve({
        provider: credRef.provider as any,
        itemRef: credRef.item_ref,
        vault: credRef.vault ?? undefined,
      });
      const env = eb.getEnvironment(session.environment);
      const newCookies = await this.performLogin(
        env,
        headless,
        creds.username || session.username,
        creds.password,
        creds.account || session.account,
      );
      if (newCookies && newCookies.length > 0) {
        db.updateSessionCookies(sessionId, JSON.stringify(newCookies));
        return newCookies;
      }
    } catch {
      // Fall through: caller reports the original failure
    }
    return null;
  }

  /**
   * Refresh session cookies periodically to maintain authentication.
   * Should be called every N operations in long-running commands.
   *
   * @param sessionId - The session ID to refresh
   * @param headless - Whether to run the refresh in headless mode
   * @returns Updated session cookies array
   */
  protected async refreshSessionCookies(
    sessionId: number,
    headless: boolean = true,
  ): Promise<any[]> {
    return await this.getSessionCookies(sessionId, headless);
  }

  /**
   * Performs authentication to retrieve fresh cookies. Can be overridden in tests.
   */
  protected async performLogin(
    env: eb.Environment,
    headless: boolean,
    username?: string,
    password?: string,
    account?: string,
  ): Promise<any[]> {
    return await eb.login(env, headless, username, password, account);
  }
}
