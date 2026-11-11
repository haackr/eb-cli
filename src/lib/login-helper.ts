import { select, input, password } from '@inquirer/prompts';
import ora from 'ora';
import * as eb from './eb-puppetmaster/index.js';
import * as db from './db.js';
import type { Account } from './eb-puppetmaster/index.js';

interface LoginOptions {
  showBrowser?: boolean;
  username?: string;
  password?: string;
  account?: string;
  environment?: string;
  ssoUrl?: string;
  getTotp?: () => Promise<string | undefined>;
}

const ENVIRONMENT_CHOICES = [
  { value: 'us1', name: 'US-1' },
  { value: 'us2', name: 'US-2' },
  { value: 'us3', name: 'US-3' },
  { value: 'us4', name: 'US-4' },
  { value: 'gov', name: 'GOV' },
  { value: 'ca', name: 'CA' },
];

/** Returns the environment for a short name (`us1`…), prompting when none was given. */
async function resolveEnvironment(shortEnv: string | undefined, message: string) {
  const chosen = shortEnv ?? (await select({ message, choices: ENVIRONMENT_CHOICES }));
  return eb.getEnvironment(chosen);
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export class SessionVerificationError extends Error {
  constructor(
    message: string,
    readonly check: eb.SessionCheckResult,
  ) {
    super(message);
    this.name = 'SessionVerificationError';
  }
}

export interface SessionHints {
  /** Username the caller already knows (flag, credential manager, typed in). */
  username?: string | undefined;
  /** Account name the caller already knows (flag, account-selection dropdown). */
  account?: string | undefined;
}

export interface FinalizeOptions {
  /** Run the verification browser headless (default true). */
  headless?: boolean | undefined;
  /** Allow prompting for anything that could not be detected (default: when on a TTY). */
  interactive?: boolean | undefined;
  /** Injection point for tests. */
  identify?: typeof eb.identifySession | undefined;
}

export interface FinalizedSession {
  sessionId: number;
  username: string;
  account: string;
  accountId: string | null;
  /** True when an existing session for the same user and account was updated in place. */
  updatedExisting: boolean;
}

/**
 * The single place every login method ends: verifies the cookies, identifies the user and
 * account from e-Builder itself, fills gaps from `hints` (then prompts, if allowed), and saves
 * the session, updating the existing row for the same user + account instead of adding a
 * duplicate. Throws SessionVerificationError when the cookies are not authenticated.
 */
export async function finalizeSession(
  env: eb.Environment,
  cookies: any[],
  hints: SessionHints = {},
  options: FinalizeOptions = {},
): Promise<FinalizedSession> {
  const headless = options.headless ?? true;
  const interactive = options.interactive ?? isInteractive();
  const identify = options.identify ?? eb.identifySession;

  const check = await eb.isLoggedIn(env, headless, cookies);
  if (!check.isLoggedIn) {
    throw new SessionVerificationError(
      eb.sessionCheckErrorFor(check, `https://${env}.${eb.baseurl}`).message,
      check,
    );
  }
  const savedCookies = check.newCookies.length > 0 ? check.newCookies : cookies;
  const identity = await identify(env, savedCookies);

  let username = identity.username || hints.username?.trim() || '';
  if (!username) {
    if (!interactive) {
      throw new Error('Could not detect the username for this session; pass --username.');
    }
    username = (await input({ message: 'Enter your username for this session:' })).trim();
  }

  let account = identity.accountName || hints.account?.trim() || '';
  if (!account && interactive) {
    account = (
      await input({ message: 'Enter account name (leave empty if none):', default: '' })
    ).trim();
  }
  const accountId = identity.accountId ?? null;

  const shortEnv = eb.getShortEnv(env);
  const cookieJson = JSON.stringify(savedCookies);
  const existing = db.findMatchingSession(username, shortEnv, {
    account,
    accountId: accountId ?? undefined,
  });

  let sessionId: number;
  if (existing) {
    sessionId = existing.id;
    db.updateSessionById(sessionId, username, shortEnv, account, cookieJson);
    db.updateSessionIdentity(sessionId, account, accountId ?? existing.account_id);
  } else {
    sessionId = db.addSession(username, shortEnv, account, cookieJson, accountId);
  }

  return { sessionId, username, account, accountId, updatedExisting: Boolean(existing) };
}

/**
 * Persists refreshed cookies for a stored session and, when its account name or account ID is
 * missing, fills them in from e-Builder. Never throws for identity lookups.
 */
export async function saveRefreshedSession(
  session: Pick<db.SessionRow, 'id' | 'environment' | 'account' | 'account_id'>,
  newCookies: any[],
  identify: typeof eb.identifySession = eb.identifySession,
): Promise<void> {
  db.updateSessionCookies(session.id, JSON.stringify(newCookies));
  if ((session.account ?? '').trim() && session.account_id) return;
  try {
    const identity = await identify(eb.getEnvironment(session.environment), newCookies);
    const account = (session.account ?? '').trim() || identity.accountName || '';
    const accountId = session.account_id || identity.accountId || null;
    if (account !== (session.account ?? '') || accountId !== session.account_id) {
      db.updateSessionIdentity(session.id, account, accountId);
    }
  } catch {
    // Identity backfill is best-effort.
  }
}

export async function promptLoginAndSaveSession(
  options: LoginOptions = {},
): Promise<FinalizedSession> {
  const env = await resolveEnvironment(
    options.environment,
    'Select the e-Builder environment you want to log in to:',
  );

  let username = options.username;
  if (!username) {
    username = await input({
      message: 'Enter your username:',
    });
  }

  const usingSso = Boolean(options.ssoUrl);
  let pass = options.password;
  if (!usingSso && !pass) {
    pass = await password({ message: 'Enter your password:', mask: '*' });
  }

  const spinner = ora(
    usingSso || options.showBrowser
      ? 'Waiting for interactive login in the browser...'
      : 'Logging in to e-Builder...',
  ).start();
  let cookies;
  try {
    if (options.ssoUrl) {
      spinner.info('Complete your SSO login in the browser window.');
      spinner.start('Waiting for SSO login in the browser...');
      cookies = await eb.loginWithSso(env, options.ssoUrl);
    } else {
      if (options.showBrowser) {
        spinner.info('Complete Trimble ID authentication in the browser if prompted.');
        spinner.start('Waiting for interactive login in the browser...');
      }
      cookies = await eb.login(
        env,
        !options.showBrowser,
        username,
        pass,
        options.account,
        async (accounts: Account[]) => {
          const selectedAccount = await accountSpecifier(accounts);
          options.account = selectedAccount.text;
          return selectedAccount.value;
        },
        undefined,
        (selectedAccount: Account) => {
          options.account = selectedAccount.text;
        },
        options.getTotp,
      );
    }
  } catch (e: any) {
    spinner.fail(`Failed to log in: ${e.message}`);
    if (e.stack) {
      console.error(e.stack);
    }
    throw e;
  }

  // No spinner while finalizing: it may prompt for missing details.
  spinner.stop();
  let saved: FinalizedSession;
  try {
    saved = await finalizeSession(
      env,
      cookies,
      { username, account: options.account },
      { headless: !options.showBrowser },
    );
  } catch (e) {
    if (e instanceof SessionVerificationError) {
      spinner.fail('Failed to verify login.');
      await eb.logout(env, !options.showBrowser, cookies).catch(() => {});
      throw new Error('Login verification failed');
    }
    throw e;
  } finally {
    // Close the browser to allow the process to exit
    await eb.BrowserManager.getInstance().closeBrowser();
  }

  spinner.succeed(describeSaved('Logged in successfully', saved));
  return saved;
}

function describeSaved(prefix: string, saved: FinalizedSession): string {
  const who = saved.account ? `${saved.username} (${saved.account})` : saved.username;
  const what = saved.updatedExisting
    ? `updated session ${saved.sessionId}`
    : `session ${saved.sessionId}`;
  return `${prefix}: ${who}, ${what}.`;
}

async function accountSpecifier(accounts: eb.Account[]): Promise<Account> {
  const selectedAccount = await select({
    message: 'Select an account:',
    choices: accounts.map((account) => ({
      name: account.text,
      value: account,
    })),
  });
  if (!selectedAccount) {
    throw new Error('No account selected');
  }
  return selectedAccount;
}

/**
 * Re-validates a stored session by loading the e-Builder home page with its cookies, persisting
 * the refreshed cookies on success. Returns the structured check result; never throws.
 * Callers must only treat `reason === 'redirected_to_login'` as proof the session is dead.
 */
export async function refreshSessionIfNeeded(
  sessionId: number,
  headless: boolean = true,
): Promise<eb.SessionCheckResult> {
  const session = db.getSessionById(sessionId);
  if (!session) {
    return {
      isLoggedIn: false,
      reason: 'unknown',
      errorMessage: `Session ${sessionId} not found`,
      newCookies: [],
    };
  }

  try {
    const env = eb.getEnvironment(session.environment);
    const cookies = JSON.parse(session.session_cookies);

    const loginCheck = await eb.isLoggedIn(env, headless, cookies);
    if (loginCheck.isLoggedIn) {
      await saveRefreshedSession(session, loginCheck.newCookies);
    }
    return loginCheck;
  } catch (err) {
    return {
      isLoggedIn: false,
      reason: eb.classifyNavigationError(err) ?? 'unknown',
      errorMessage: err instanceof Error ? err.message : String(err),
      newCookies: [],
    };
  }
}

export interface ImportOptions {
  showBrowser?: boolean | undefined;
  username?: string | undefined;
  account?: string | undefined;
  environment?: string | undefined;
  profile?: string | undefined;
  chromeDataDir?: string | undefined;
}

export async function promptImportAndSaveSession(
  options: ImportOptions = {},
): Promise<FinalizedSession> {
  const env = await resolveEnvironment(
    options.environment,
    'Select the e-Builder environment you want to import the session from:',
  );

  const showBrowser = options.showBrowser ?? true;
  const spinner = ora('Importing session from Google Chrome...').start();

  let importResult: eb.ImportSessionResult;
  try {
    importResult = await eb.importSessionFromChrome({
      env,
      profile: options.profile,
      chromeDataDir: options.chromeDataDir,
      headless: !showBrowser,
      onAccountSelected: (selectedAccount: eb.Account) => {
        if (!options.account) {
          options.account = selectedAccount.text;
        }
      },
    });
  } catch (e: any) {
    spinner.fail(`Failed to import session from Chrome: ${e.message}`);
    throw e;
  }

  // No spinner while finalizing: it may prompt for missing details.
  spinner.stop();
  let saved: FinalizedSession;
  try {
    saved = await finalizeSession(env, importResult.cookies, {
      username: options.username || importResult.username,
      account: options.account || importResult.account,
    });
  } catch (e) {
    if (e instanceof SessionVerificationError) {
      spinner.fail('Failed to verify imported session.');
      throw new Error('Login verification failed for imported session.');
    }
    throw e;
  } finally {
    await eb.BrowserManager.getInstance().closeBrowser();
  }

  spinner.succeed(
    describeSaved(
      importResult.isAlreadyLoggedIn
        ? 'Active Chrome session imported'
        : 'Logged in and session imported',
      saved,
    ),
  );
  return saved;
}
