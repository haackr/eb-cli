import { Args, Command, Flags } from "@oclif/core";

export default class DeleteBudgetitems extends Command {
  static override args = {
    file: Args.string({ description: "csv of budget items to delete" }),
  };
  static override description = "deletes budget items as specified in csv file";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = {
    // flag with no value (-f, --force)
    force: Flags.boolean({ char: "f" }),
    // flag with a value (-n, --name=VALUE)
    name: Flags.string({ char: "n", description: "name to print" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DeleteBudgetitems);

    const name = flags.name ?? "world";
    this.log(
      `hello ${name} from /Users/ryan/dev/eb-cli/src/commands/delete/budgetitems.ts`
    );
    if (args.file && flags.force) {
      this.log(`you input --force and --file: ${args.file}`);
    }
  }
}
