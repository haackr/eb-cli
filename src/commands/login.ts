import { Args, Command, Flags } from "@oclif/core";
import { password, select, input } from "@inquirer/prompts";
import puppeteer from "puppeteer";
import * as eb from "../lib/eb-puppetmaster/auth.js";

export default class Login extends Command {
  static override args = {
    file: Args.string({ description: "file to read" }),
  };
  static override description = "log in to e-Builder";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = {
    show_browser: Flags.boolean({
      char: "s",
      description:
        "show browser window (useful for debugging; default is headless)",
    }),
    username: Flags.string({ char: "u", description: "username" }),
    account: Flags.string({ char: "a", description: "account" }),
    environment: Flags.string({
      char: "e",
      description: "environment",
      options: ["us1", "us2", "us3", "us4", "gov", "ca"],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Login);

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

    const cookies = await eb.login(
      env,
      !flags.show_browser,
      flags.username,
      pass,
      flags.account
    );
    // this.log(JSON.stringify(cookies));
    const isLoggedIn = await eb.isLoggedIn(env, !flags.show_browser, cookies);
    this.log(`Logged in: ${isLoggedIn}`);
    eb.logout(eb.Environment.US3, !flags.show_browser, cookies);
  }
}
