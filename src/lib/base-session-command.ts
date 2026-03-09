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
    'show-browser': Flags.boolean({
      char: 's',
      description: 'Show browser window',
    }),
  };

  /**
   * Resolve and return a session based on flags or user selection.
   * Handles session lookup by ID, username, or interactive selection.
   * Will prompt for login if no sessions exist.
   *
   * @param flags - Command flags containing session-id, username, and show-browser
   * @returns The resolved SessionRow
   */
  protected async getSession(flags: {
    'session-id'?: number | undefined;
    username?: string | undefined;
    'show-browser'?: boolean | undefined;
  }): Promise<SessionRow> {
    let session: SessionRow | undefined;

    if (flags['session-id']) {
      session = db.getSessionById(flags['session-id']) as SessionRow;
      if (!session) {
        this.error(`Session with ID ${flags['session-id']} not found.`);
      }
    } else if (flags.username) {
      const sessions = db.getSessionsByUsername(flags.username) as SessionRow[];
      if (sessions.length === 0) {
        this.error(`No sessions found for username ${flags.username}.`);
      } else if (sessions.length === 1) {
        session = sessions[0];
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
   * If multiple sessions exist, prompts user to select one.
   *
   * @param showBrowser - Whether to show the browser during login
   * @returns The selected or newly created SessionRow
   */
  private async getOrCreateSession(showBrowser?: boolean | undefined): Promise<SessionRow> {
    const allSessions = db.getSessions() as SessionRow[];

    if (allSessions.length === 0) {
      this.log('No open sessions found. Please log in first.');
      await promptLoginAndSaveSession({ showBrowser: showBrowser ?? false });
      const newSessions = db.getSessions() as SessionRow[];
      if (newSessions.length === 0) {
        this.error('Failed to create session.');
      }
      return newSessions.length === 1 ? newSessions[0]! : await this.selectSession(newSessions);
    }

    return allSessions.length === 1 ? allSessions[0]! : await this.selectSession(allSessions);
  }

  /**
   * Get session cookies, refreshing the session if needed.
   * Throws an error if the session has expired and cannot be refreshed.
   *
   * @param sessionId - The session ID to get cookies for
   * @param headless - Whether to run the refresh in headless mode (default: true)
   * @returns Parsed session cookies array
   */
  protected async getSessionCookies(sessionId: number, headless: boolean = true): Promise<any[]> {
    if (!(await refreshSessionIfNeeded(sessionId, headless))) {
      this.error("Session has expired. Please log in again using 'eb login'.");
    }
    const session = db.getSessionById(sessionId) as SessionRow;
    return JSON.parse(session.session_cookies);
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
}
