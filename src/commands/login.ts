import { Command, Flags } from '@oclif/core';
import { promptLoginAndSaveSession } from '../lib/login-helper.js';

export default class Login extends Command {
  static override description = 'log in to e-Builder';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --show_browser # keep browser visible during login',
    '<%= config.bin %> <%= command.id %> --username jane.doe --environment us1 --sso-url https://idp.example.com/ebuilder',
  ];
  static override flags = {
    show_browser: Flags.boolean({
      char: 's',
      description: 'show browser window (useful for debugging; default is headless)',
    }),
    username: Flags.string({ char: 'u', description: 'username' }),
    password: Flags.string({ char: 'p', description: 'password' }),
    account: Flags.string({
      char: 'a',
      description: 'account (if the user has access to multiple accounts)',
    }),
    environment: Flags.string({
      char: 'e',
      description: 'environment',
      options: ['us1', 'us2', 'us3', 'us4', 'gov', 'ca'],
    }),
    'sso-url': Flags.string({
      description: 'SSO entry URL; opens a browser for interactive provider authentication',
    }),
    provider: Flags.string({
      description: 'Credential manager provider (1password, bitwarden, keychain, env)',
      options: ['1password', 'bitwarden', 'keychain', 'env'],
    }),
    item: Flags.string({
      description:
        'Item name, title, or reference in the credential manager (default: "e-Builder")',
    }),
    vault: Flags.string({
      description: '1Password vault name or ID',
    }),
  };
  static override aliases: string[] = ['session:create'];

  public async run(): Promise<void> {
    const { flags } = await this.parse(Login);

    const options: {
      showBrowser?: boolean;
      username?: string;
      password?: string;
      account?: string;
      environment?: string;
      ssoUrl?: string;
      getTotp?: () => Promise<string | undefined>;
    } = {};
    if (flags.show_browser !== undefined) options.showBrowser = flags.show_browser;
    if (flags.username) options.username = flags.username;
    if (flags.password) options.password = flags.password;
    if (flags.account) options.account = flags.account;
    if (flags.environment) options.environment = flags.environment;
    if (flags['sso-url']) options.ssoUrl = flags['sso-url'];

    let itemRef: string | undefined;
    if (flags.provider) {
      const { CredentialResolver } = await import('../lib/credentials/resolver.js');
      itemRef = flags.item || 'e-Builder';
      const creds = await CredentialResolver.resolve({
        provider: flags.provider as any,
        itemRef,
        vault: flags.vault,
      });
      if (creds.username && !options.username) options.username = creds.username;
      if (creds.password && !options.password) options.password = creds.password;
      if (creds.account && !options.account) options.account = creds.account;
      if (creds.environment && !options.environment) options.environment = creds.environment;

      options.getTotp = async () => {
        return CredentialResolver.getLiveTotp({
          provider: flags.provider as any,
          itemRef: itemRef!,
          vault: flags.vault,
        });
      };
    }

    await promptLoginAndSaveSession(options);

    if (flags.provider && itemRef) {
      const db = await import('../lib/db.js');
      const allSessions = db.getSessions();
      if (allSessions.length > 0) {
        const latest = [...allSessions].sort((a, b) => b.id - a.id)[0]!;
        db.setCredentialRef(latest.id, flags.provider, itemRef, flags.vault);
      }
    }

    this.log(`Session saved!`);
  }
}
