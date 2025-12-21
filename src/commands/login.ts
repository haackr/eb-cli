import { Command, Flags } from "@oclif/core";
import { promptLoginAndSaveSession } from "../lib/login-helper.js";

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
    password: Flags.string({ char: "p", description: "password" }),
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

    const options: any = {};
    if (flags.show_browser !== undefined)
      options.showBrowser = flags.show_browser;
    if (flags.username) options.username = flags.username;
    if (flags.password) options.password = flags.password;
    if (flags.account) options.account = flags.account;
    if (flags.environment) options.environment = flags.environment;

    await promptLoginAndSaveSession(options);

    this.log(`Session saved!`);
  }
}
