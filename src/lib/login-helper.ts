import { select, input, password } from "@inquirer/prompts";
import ora from "ora";
import * as eb from "./eb-puppetmaster/index.js";
import * as db from "./db.js";
import type { Account } from "./eb-puppetmaster/index.js";

interface LoginOptions {
  showBrowser?: boolean;
  username?: string;
  password?: string;
  account?: string;
  environment?: string;
}

export async function promptLoginAndSaveSession(
  options: LoginOptions = {}
): Promise<void> {
  let environment = options.environment;
  if (!environment) {
    environment = await select({
      message: "Select the e-Builder environment you want to log in to:",
      choices: [
        { value: "us1", name: "US-1" },
        { value: "us2", name: "US-2" },
        { value: "us3", name: "US-3" },
        { value: "us4", name: "US-4" },
        { value: "gov", name: "GOV" },
        { value: "ca", name: "CA" },
      ],
    });
  }

  let env: eb.Environment;
  switch (environment) {
    case "us1":
      env = eb.Environment.US1;
      break;
    case "us2":
      env = eb.Environment.US2;
      break;
    case "us3":
      env = eb.Environment.US3;
      break;
    case "us4":
      env = eb.Environment.US4;
      break;
    case "gov":
      env = eb.Environment.GOV;
      break;
    case "ca":
      env = eb.Environment.CA;
      break;
    default:
      throw new Error(`Unknown environment: ${environment}`);
  }

  let username = options.username;
  if (!username) {
    username = await input({
      message: "Enter your username:",
    });
  }

  let pass = options.password;
  if (!pass) {
    pass = await password({ message: "Enter your password:", mask: "*" });
  }

  const spinner = ora("Logging in to e-Builder...").start();
  let cookies: any[] = [];
  try {
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
      }
    );
  } catch (e: any) {
    spinner.fail(`Failed to log in: ${e.message}`);
    throw e;
  }

  const isLoggedIn = await eb.isLoggedIn(env, !options.showBrowser, cookies);
  if (!isLoggedIn) {
    spinner.fail("Failed to verify login.");
    await eb.logout(env, !options.showBrowser, cookies);
    throw new Error("Login verification failed");
  }

  spinner.succeed("Logged in successfully!");
  db.addSession(
    username,
    eb.getShortEnv(env),
    options.account || "",
    JSON.stringify(cookies)
  );

  // Close the browser to allow the process to exit
  await eb.BrowserManager.getInstance().closeBrowser();
}

async function accountSpecifier(accounts: eb.Account[]): Promise<Account> {
  const selectedAccount = await select({
    message: "Select an account:",
    choices: accounts.map((account) => ({
      name: account.text,
      value: account,
    })),
  });
  if (!selectedAccount) {
    throw new Error("No account selected");
  }
  return selectedAccount;
}

export async function refreshSessionIfNeeded(
  sessionId: number,
  headless: boolean = true
): Promise<boolean> {
  const session = db.getSessionById(sessionId) as
    | { environment: string; session_cookies: string }
    | undefined;
  if (!session) return false;

  const env = eb.getEnvironment(session.environment);
  const cookies = JSON.parse(session.session_cookies);

  const loginCheck = await eb.isLoggedIn(env, headless, cookies);
  if (loginCheck.isLoggedIn) {
    db.updateSessionCookies(sessionId, JSON.stringify(loginCheck.newCookies));
    return true;
  }
  return false;
}
