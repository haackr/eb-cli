import { Command, Flags } from '@oclif/core';
import { promptLoginAndSaveSession } from '../lib/login-helper.js';

export default class Login extends Command {
  static override description = `log in to e-Builder

With no password or credential provider, eb opens a browser window: sign in the way you normally do (password, passkey, MFA, SSO) and the session is saved as soon as e-Builder loads. With --provider (or --password), eb signs in for you headlessly. The username and account are detected from e-Builder either way.`;
  static override examples = [
    '<%= config.bin %> <%= command.id %> # sign in yourself in a browser window',
    '<%= config.bin %> <%= command.id %> --environment us2',
    '<%= config.bin %> <%= command.id %> --provider 1password --item "e-Builder" # automated',
    '<%= config.bin %> <%= command.id %> --no-browser # type username/password in the terminal',
    '<%= config.bin %> <%= command.id %> --sso-url https://idp.example.com/ebuilder',
  ];
  static override flags = {
    browser: Flags.boolean({
      char: 'b',
      allowNo: true,
      description:
        'sign in yourself in a browser window (default when no password or --provider is given); --no-browser prompts for username/password in the terminal instead',
    }),
    show_browser: Flags.boolean({
      char: 's',
      description: 'automated login only: show the browser window (useful for debugging)',
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
      browser?: boolean;
      showBrowser?: boolean;
      username?: string;
      password?: string;
      account?: string;
      environment?: string;
      ssoUrl?: string;
      getTotp?: () => Promise<string | undefined>;
    } = {};
    if (flags.browser !== undefined) options.browser = flags.browser;
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

    const saved = await promptLoginAndSaveSession(options);

    if (flags.provider && itemRef) {
      const db = await import('../lib/db.js');
      db.setCredentialRef(saved.sessionId, flags.provider, itemRef, flags.vault);
    }
  }
}
