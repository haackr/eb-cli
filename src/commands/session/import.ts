import { Command, Flags } from '@oclif/core';
import { promptImportAndSaveSession } from '../../lib/login-helper.js';

export default class SessionImport extends Command {
  static override description = `import the e-Builder session you are signed in to in Google Chrome

Connects to your running Chrome over remote debugging, reads only the e-Builder cookies, and disconnects; your browser and tabs are left as they are. Requires Chrome 144+ with remote debugging allowed at chrome://inspect/#remote-debugging (one-time setup; eb opens that page for you if needed). Chrome asks you to approve each connection.

The environment, username, and account are detected from the session itself.

The imported session is the same login as your Chrome tab: logging out of either one (eb logout or e-Builder's Log Out) ends both.`;
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --environment us2 # when Chrome is signed in to several',
  ];
  static override flags = {
    username: Flags.string({
      char: 'u',
      description: 'username to save if it cannot be detected',
    }),
    account: Flags.string({
      char: 'a',
      description: 'account name to save if it cannot be detected',
    }),
    environment: Flags.string({
      char: 'e',
      description: 'environment to import (default: the one Chrome is signed in to)',
      options: ['us1', 'us2', 'us3', 'us4', 'gov', 'ca'],
    }),
    'chrome-data-dir': Flags.string({
      description: 'Chrome user data directory (default: the standard Google Chrome location)',
    }),
    timeout: Flags.integer({
      description: 'seconds to wait for remote debugging to be enabled and approved',
      default: 120,
      min: 5,
    }),
  };
  static override aliases: string[] = ['session:import'];

  public async run(): Promise<void> {
    const { flags } = await this.parse(SessionImport);

    await promptImportAndSaveSession({
      username: flags.username,
      account: flags.account,
      environment: flags.environment,
      chromeDataDir: flags['chrome-data-dir'],
      timeoutMs: flags.timeout * 1000,
    });
  }
}
