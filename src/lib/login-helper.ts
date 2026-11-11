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
  /** True when a stored session for the same e-Builder login was updated in place. */
  updatedExisting: boolean;
}

/**
 * The single place every login method ends: verifies the cookies, identifies the user and
 * account from e-Builder itself, fills gaps from `hints` (then prompts, if allowed), and saves
 * the session as a new row, unless a stored row already holds this same login (then that row
 * is updated). Throws SessionVerificationError when the cookies are not authenticated.
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
  const existing = findSameLogin(env, [cookies, savedCookies]);

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
 * The stored session holding the same e-Builder login (same ASP.NET session id), if any.
 * Only that case is updated in place: a *different* login always gets its own row, because
 * overwriting it would orphan a live server session that could then never be logged out (and
 * e-Builder caps concurrent sessions per user).
 */
function findSameLogin(env: eb.Environment, cookieSets: any[][]): db.SessionRow | undefined {
  const ids = new Set(
    cookieSets.map((c) => eb.getServerSessionId(env, c)).filter((v): v is string => Boolean(v)),
  );
  if (ids.size === 0) return undefined;
  const shortEnv = eb.getShortEnv(env);
  return db
    .getSessions()
    .filter((s) => s.environment === shortEnv)
    .find((s) => {
      try {
        const sid = eb.getServerSessionId(env, JSON.parse(s.session_cookies));
        return sid !== undefined && ids.has(sid);
      } catch {
        return false;
      }
    });
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
  username?: string | undefined;
  account?: string | undefined;
  environment?: string | undefined;
  chromeDataDir?: string | undefined;
  /** How long to wait for remote debugging to be enabled and approved (default 2 minutes). */
  timeoutMs?: number | undefined;
  /** Injection point for tests. */
  readCookies?: typeof eb.readChromeCookies | undefined;
  /** Passed through to finalizeSession. */
  finalize?: FinalizeOptions | undefined;
}

/** Picks the environment to import from the ones Chrome has a session for. */
async function chooseImportEnvironment(
  detected: eb.Environment[],
  requested: string | undefined,
  interactive: boolean,
): Promise<eb.Environment> {
  const label = (env: eb.Environment) => eb.getDisplayName(eb.getShortEnv(env));
  if (requested) {
    const env = eb.getEnvironment(requested);
    if (!detected.includes(env)) {
      throw new Error(
        `Chrome has no e-Builder session for ${label(env)}.${
          detected.length ? ` Found: ${detected.map(label).join(', ')}.` : ''
        } Sign in to ${label(env)} in Chrome first.`,
      );
    }
    return env;
  }
  if (detected.length === 0) {
    throw new Error(
      'Chrome has no signed-in e-Builder session. Sign in to e-Builder in Chrome, then run this again.',
    );
  }
  if (detected.length === 1) return detected[0]!;
  if (!interactive) {
    throw new Error(
      `Chrome is signed in to several e-Builder environments (${detected.map(label).join(', ')}); pass --environment.`,
    );
  }
  return await select({
    message: 'Chrome is signed in to several environments. Which one do you want to import?',
    choices: detected.map((env) => ({ value: env, name: label(env) })),
  });
}

/**
 * Imports the e-Builder session from the user's running Google Chrome (remote debugging must be
 * allowed at chrome://inspect/#remote-debugging; Chrome asks the user to approve the connection).
 */
export async function promptImportAndSaveSession(
  options: ImportOptions = {},
): Promise<FinalizedSession> {
  if (options.environment) eb.getEnvironment(options.environment); // validate early
  const readCookies = options.readCookies ?? eb.readChromeCookies;
  const interactive = options.finalize?.interactive ?? isInteractive();

  const spinner = ora('Connecting to Google Chrome...').start();
  let cookies: Awaited<ReturnType<typeof eb.readChromeCookies>>;
  try {
    cookies = await readCookies({
      chromeDataDir: options.chromeDataDir,
      timeoutMs: options.timeoutMs,
      onNeedsSetup: () => {
        spinner.info(
          `Remote debugging is not enabled in Chrome. In Chrome, open ${eb.REMOTE_DEBUGGING_SETTINGS_URL} and turn on "Allow remote debugging for this browser instance".`,
        );
        if (interactive) eb.openRemoteDebuggingSettings();
        spinner.start('Waiting for remote debugging to be enabled...');
      },
      onAwaitingApproval: () => {
        spinner.text = 'Click "Allow" in Chrome to let eb read your e-Builder session...';
      },
    });
  } catch (e: any) {
    spinner.fail(`Failed to import session from Chrome: ${e.message}`);
    throw e;
  }
  spinner.stop();

  const env = await chooseImportEnvironment(
    eb.detectEnvironments(cookies),
    options.environment,
    interactive,
  );

  let saved: FinalizedSession;
  try {
    saved = await finalizeSession(
      env,
      eb.cookiesForEnvironment(env, cookies),
      { username: options.username, account: options.account },
      options.finalize,
    );
  } catch (e) {
    if (e instanceof SessionVerificationError) {
      ora().fail('The e-Builder session in Chrome is no longer valid. Sign in again in Chrome.');
      throw new Error('Login verification failed for imported session.');
    }
    throw e;
  } finally {
    await eb.BrowserManager.getInstance().closeBrowser();
  }

  ora().succeed(describeSaved('Imported Chrome session', saved));
  return saved;
}
