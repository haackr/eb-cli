import { Command, Flags } from "@oclif/core";
import { password, select, input } from "@inquirer/prompts";
import { type Cookie } from "puppeteer";
import ora from "ora";
import * as eb from "../lib/eb-puppetmaster/auth.js";
import * as db from "../lib/db.js";

export default class Login extends Command {
  static override description = "log in to e-Builder";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = {
    show_browser: Flags.boolean({
      char: "s",
      description:
        "show browser window (useful for debugging; default is headless)",
    }),
    username: Flags.string({ char: "u", description: "username" }),
    account: Flags.string({
      char: "a",
      description: "account (if the user has access to multiple accounts)",
    }),
    environment: Flags.string({
      char: "e",
      description: "environment",
      options: ["us1", "us2", "us3", "us4", "gov", "ca"],
    }),
  };
  static override aliases: string[] = ["session:create"];

  public async run(): Promise<void> {
    const { flags } = await this.parse(Login);

    if (!flags.environment) {
      flags.environment = await select({
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
    switch (flags.environment) {
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
        throw new Error(`Unknown environment: ${flags.environment}`);
    }

    if (!flags.username && !flags.show_browser) {
      flags.username = await input({
        message: "Enter your username:",
      });
    }

    let pass: string | undefined;
    if (flags.username) {
      pass = await password({ message: "Enter your password:", mask: "*" });
    }
    const spinner = ora("Logging in to e-Builder...").start();
    let cookies: Cookie[] = [];
    try {
      cookies = await eb.login(
        env,
        !flags.show_browser,
        flags.username,
        pass,
        flags.account,
        async (accounts: eb.Account[]) => {
          const selectedAccount = await accountSpecifier(accounts);
          flags.account = selectedAccount.text;
          return selectedAccount.value;
        }
      );
    } catch (e: any) {
      spinner.fail(`Failed to log in: ${e.message}`);
      process.exit(1);
    }
    spinner.succeed("Logged in successfully!");
    const isLoggedIn = await eb.isLoggedIn(env, !flags.show_browser, cookies);
    if (!isLoggedIn) {
      this.error("Failed to verify login. Attepting to log out...");
      await eb.logout(env, !flags.show_browser, cookies);
      process.exit(1);
    }

    // Calculate session expiration from cookies
    let expiresAt: number | null = null;
    for (const cookie of cookies) {
      if (cookie.expires !== undefined && cookie.expires !== -1) {
        if (expiresAt === null || cookie.expires < expiresAt) {
          expiresAt = cookie.expires;
        }
      }
    }

    db.addSession(
      flags.username || "",
      env,
      flags.account || "",
      JSON.stringify(cookies),
      expiresAt
    );
    this.log(`Session saved!`);
    // this.log(JSON.stringify(cookies));
  }
}

async function accountSpecifier(accounts: eb.Account[]): Promise<eb.Account> {
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
