import { Args, Command, Flags } from "@oclif/core";

export default class DeleteUsers extends Command {
  static override args = {
    file: Args.string({ description: "csv of users to delete" }),
  };
  static override description = "deletes users as specified in csv file";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = {
    // flag with no value (-f, --force)
    force: Flags.boolean({ char: "f" }),
    // flag with a value (-n, --name=VALUE)
    name: Flags.string({ char: "n", description: "name to print" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DeleteUsers);

    const name = flags.name ?? "world";
    this.log(
      `hello ${name} from /Users/ryan/dev/eb-cli/src/commands/delete/users.ts`
    );
    if (args.file && flags.force) {
      this.log(`you input --force and --file: ${args.file}`);
    }
  }
}
