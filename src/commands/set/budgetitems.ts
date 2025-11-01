import { Args, Command, Flags } from "@oclif/core";

export default class SetBudgetitems extends Command {
  static override args = {
    file: Args.string({ description: "csv of budget items to set" }),
  };
  static override description =
    "sets flags on budget items as specified in csv file";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = {
    // flag with no value (-f, --force)
    force: Flags.boolean({ char: "f" }),
    // flag with a value (-n, --name=VALUE)
    name: Flags.string({ char: "n", description: "name to print" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SetBudgetitems);

    const name = flags.name ?? "world";
    this.log(
      `hello ${name} from /Users/ryan/dev/eb-cli/src/commands/set/budgetitems.ts`
    );
    if (args.file && flags.force) {
      this.log(`you input --force and --file: ${args.file}`);
    }
  }
}
