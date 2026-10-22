import { Command, Flags } from '@oclif/core';
import { promptImportAndSaveSession } from '../../lib/login-helper.js';

export default class SessionImport extends Command {
  static override description = 'import an active e-Builder session from Google Chrome';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --environment us1',
    '<%= config.bin %> <%= command.id %> --profile "Profile 1"',
    '<%= config.bin %> <%= command.id %> --username jane.doe --account "Acme Corp"',
    '<%= config.bin %> <%= command.id %> --no-show_browser',
  ];
  static override flags = {
    show_browser: Flags.boolean({
      char: 's',
      description: 'show browser window (default is true)',
      default: true,
      allowNo: true,
    }),
    username: Flags.string({ char: 'u', description: 'username' }),
    account: Flags.string({
      char: 'a',
      description: 'account (if the user has access to multiple accounts)',
    }),
    environment: Flags.string({
      char: 'e',
      description: 'environment',
      options: ['us1', 'us2', 'us3', 'us4', 'gov', 'ca'],
    }),
    profile: Flags.string({
      char: 'P',
      description: 'Chrome profile directory name (default: Default)',
      default: 'Default',
    }),
    'chrome-data-dir': Flags.string({
      description: 'custom Chrome user data directory path',
    }),
  };
  static override aliases: string[] = ['session:import'];

  public async run(): Promise<void> {
    const { flags } = await this.parse(SessionImport);

    await promptImportAndSaveSession({
      showBrowser: flags.show_browser,
      username: flags.username,
      account: flags.account,
      environment: flags.environment,
      profile: flags.profile,
      chromeDataDir: flags['chrome-data-dir'],
    });

    this.log('Session saved!');
  }
}
