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

export async function promptLoginAndSaveSession(options: LoginOptions = {}): Promise<void> {
  let environment = options.environment;
  if (!environment) {
    environment = await select({
      message: 'Select the e-Builder environment you want to log in to:',
      choices: [
        { value: 'us1', name: 'US-1' },
        { value: 'us2', name: 'US-2' },
        { value: 'us3', name: 'US-3' },
        { value: 'us4', name: 'US-4' },
        { value: 'gov', name: 'GOV' },
        { value: 'ca', name: 'CA' },
      ],
    });
  }

  let env: eb.Environment;
  switch (environment) {
    case 'us1':
      env = eb.Environment.US1;
      break;
    case 'us2':
      env = eb.Environment.US2;
      break;
    case 'us3':
      env = eb.Environment.US3;
      break;
    case 'us4':
      env = eb.Environment.US4;
      break;
    case 'gov':
      env = eb.Environment.GOV;
      break;
    case 'ca':
      env = eb.Environment.CA;
      break;
    default:
      throw new Error(`Unknown environment: ${environment}`);
  }

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

  const loginCheck = await eb.isLoggedIn(env, !options.showBrowser, cookies);
  if (!loginCheck.isLoggedIn) {
    spinner.fail('Failed to verify login.');
    await eb.logout(env, !options.showBrowser, cookies);
    throw new Error('Login verification failed');
  }

  spinner.succeed('Logged in successfully!');
  db.addSession(
    username,
    eb.getShortEnv(env),
    options.account || '',
    JSON.stringify(loginCheck.newCookies),
  );

  // Close the browser to allow the process to exit
  await eb.BrowserManager.getInstance().closeBrowser();
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

export async function refreshSessionIfNeeded(
  sessionId: number,
  headless: boolean = true,
): Promise<boolean> {
  try {
    const session = db.getSessionById(sessionId) as
      { environment: string; session_cookies: string } | undefined;
    if (!session) return false;

    const env = eb.getEnvironment(session.environment);
    const cookies = JSON.parse(session.session_cookies);

    const loginCheck = await eb.isLoggedIn(env, headless, cookies);
    if (loginCheck.isLoggedIn) {
      db.updateSessionCookies(sessionId, JSON.stringify(loginCheck.newCookies));
      return true;
    }
    return false;
  } catch {
    return false;
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

export async function promptImportAndSaveSession(options: ImportOptions = {}): Promise<void> {
  let environment = options.environment;
  if (!environment) {
    environment = await select({
      message: 'Select the e-Builder environment you want to import the session from:',
      choices: [
        { value: 'us1', name: 'US-1' },
        { value: 'us2', name: 'US-2' },
        { value: 'us3', name: 'US-3' },
        { value: 'us4', name: 'US-4' },
        { value: 'gov', name: 'GOV' },
        { value: 'ca', name: 'CA' },
      ],
    });
  }

  let env: eb.Environment;
  switch (environment) {
    case 'us1':
      env = eb.Environment.US1;
      break;
    case 'us2':
      env = eb.Environment.US2;
      break;
    case 'us3':
      env = eb.Environment.US3;
      break;
    case 'us4':
      env = eb.Environment.US4;
      break;
    case 'gov':
      env = eb.Environment.GOV;
      break;
    case 'ca':
      env = eb.Environment.CA;
      break;
    default:
      throw new Error(`Unknown environment: ${environment}`);
  }

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

  spinner.start('Verifying imported session...');
  const loginCheck = await eb.isLoggedIn(env, true, importResult.cookies);
  if (!loginCheck.isLoggedIn) {
    spinner.fail('Failed to verify imported session.');
    throw new Error('Login verification failed for imported session.');
  }

  spinner.succeed(
    importResult.isAlreadyLoggedIn
      ? 'Active Chrome session detected and imported!'
      : 'Logged in and session imported!',
  );

  let username = options.username || importResult.username;
  if (!username) {
    username = await input({
      message: 'Enter your username for this session:',
    });
  }

  let account = options.account || importResult.account || '';
  if (!account && options.account === undefined) {
    account = await input({
      message: 'Enter account name (leave empty if none):',
      default: '',
    });
  }

  const savedCookies =
    loginCheck.newCookies && loginCheck.newCookies.length > 0
      ? loginCheck.newCookies
      : importResult.cookies;

  db.addSession(username, eb.getShortEnv(env), account, JSON.stringify(savedCookies));

  await eb.BrowserManager.getInstance().closeBrowser();
}
