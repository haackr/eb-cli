import spawn from 'cross-spawn';
import type { CredentialProviderType, CredentialReference, ResolvedCredentials } from './types.js';

export class CredentialResolver {
  /**
   * Check if the CLI executable for the given provider is available on PATH.
   */
  public static isProviderAvailable(provider: CredentialProviderType): boolean {
    if (provider === 'env') return true;
    if (provider === '1password') return this.canExecute('op', ['--version']);
    if (provider === 'bitwarden') return this.canExecute('bw', ['--version']);
    if (provider === 'keychain') {
      // macOS-only; `security` has no --version, so just look it up on PATH.
      return process.platform === 'darwin' && this.canExecute('which', ['security']);
    }
    return false;
  }

  /**
   * Cross-platform check that a command can be launched. Runs it directly
   * rather than via `which` (absent on Windows).
   */
  private static canExecute(cmd: string, args: string[]): boolean {
    try {
      this.run(cmd, args, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a CLI synchronously and return stdout; throws on failure.
   * Uses cross-spawn so Windows resolves PATHEXT and can launch `.cmd`/`.bat`
   * shims (e.g. npm-installed `bw.cmd`) with args safely escaped for cmd.exe.
   */
  private static run(cmd: string, args: string[], timeout?: number): string {
    const res = spawn.sync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = (res.stderr || '').trim();
      throw new Error(
        `Command failed: ${cmd} ${args[0] ?? ''} (exit ${res.status ?? res.signal})${stderr ? `\n${stderr}` : ''}`,
      );
    }
    return res.stdout;
  }

  /**
   * Resolve credentials in-memory for headless authentication.
   * NEVER pass the returned object to AI agent prompts or logs.
   */
  public static async resolve(ref: CredentialReference): Promise<ResolvedCredentials> {
    switch (ref.provider) {
      case '1password':
        return this.resolveFrom1Password(ref.itemRef, ref.vault);
      case 'bitwarden':
        return this.resolveFromBitwarden(ref.itemRef);
      case 'keychain':
        return this.resolveFromKeychain(ref.itemRef);
      case 'env':
        return this.resolveFromEnv();
      default:
        throw new Error(`Unsupported credential provider: ${ref.provider}`);
    }
  }

  /**
   * Generate a live 6-digit TOTP code if configured on the item.
   */
  public static async getLiveTotp(ref: CredentialReference): Promise<string | undefined> {
    if (ref.provider === '1password') {
      try {
        const args = ['item', 'get', ref.itemRef, '--otp'];
        if (ref.vault) {
          args.push('--vault', ref.vault);
        }
        const output = this.run('op', args);
        const code = output.trim();
        return /^\d{6,8}$/.test(code) ? code : undefined;
      } catch {
        return undefined;
      }
    }

    if (ref.provider === 'bitwarden') {
      try {
        const output = this.run('bw', ['get', 'totp', ref.itemRef]);
        const code = output.trim();
        return /^\d{6,8}$/.test(code) ? code : undefined;
      } catch {
        return undefined;
      }
    }

    if (ref.provider === 'env') {
      return process.env['EB_TOTP']?.trim();
    }

    return undefined;
  }

  private static resolveFrom1Password(itemRef: string, vault?: string): ResolvedCredentials {
    if (!this.isProviderAvailable('1password')) {
      throw new Error(
        "1Password CLI ('op') not found on PATH. Please install 'op' or use another credential provider.",
      );
    }

    const args = ['item', 'get', itemRef, '--format', 'json'];
    if (vault) {
      args.push('--vault', vault);
    }

    let stdout: string;
    try {
      stdout = this.run('op', args);
    } catch (err: any) {
      throw new Error(`Failed to read item "${itemRef}" from 1Password: ${err.message}`);
    }

    const item = JSON.parse(stdout);
    const result: ResolvedCredentials = {};

    const fields: Array<{
      id?: string;
      label?: string;
      type?: string;
      purpose?: string;
      value?: string;
    }> = item.fields || [];

    for (const f of fields) {
      const id = (f.id || '').toLowerCase();
      const label = (f.label || '').toLowerCase();
      const purpose = (f.purpose || '').toUpperCase();

      if (purpose === 'USERNAME' || id === 'username' || label === 'username' || label === 'user') {
        result.username = f.value;
      } else if (purpose === 'PASSWORD' || id === 'password' || label === 'password') {
        result.password = f.value;
      } else if (
        f.type === 'OTP' ||
        id === 'totp' ||
        label === 'totp' ||
        label === 'one-time password'
      ) {
        result.totp = f.value;
      } else if (label === 'account' || id === 'account') {
        result.account = f.value;
      } else if (label === 'environment' || id === 'environment' || label === 'env') {
        result.environment = f.value;
      }
    }

    return result;
  }

  private static resolveFromBitwarden(itemRef: string): ResolvedCredentials {
    if (!this.isProviderAvailable('bitwarden')) {
      throw new Error(
        "Bitwarden CLI ('bw') not found on PATH. Please install 'bw' or use another credential provider.",
      );
    }

    let stdout: string;
    try {
      stdout = this.run('bw', ['get', 'item', itemRef]);
    } catch (err: any) {
      throw new Error(`Failed to read item "${itemRef}" from Bitwarden: ${err.message}`);
    }

    const item = JSON.parse(stdout);
    const result: ResolvedCredentials = {
      username: item.login?.username,
      password: item.login?.password,
      totp: item.login?.totp,
    };

    if (Array.isArray(item.fields)) {
      for (const f of item.fields) {
        const name = (f.name || '').toLowerCase();
        if (name === 'account') result.account = f.value;
        if (name === 'environment' || name === 'env') result.environment = f.value;
      }
    }

    return result;
  }

  private static resolveFromKeychain(itemRef: string): ResolvedCredentials {
    if (!this.isProviderAvailable('keychain')) {
      throw new Error('Keychain security CLI not available on this platform.');
    }

    try {
      const stdout = this.run('security', ['find-generic-password', '-s', itemRef, '-w']);
      return {
        password: stdout.trim(),
      };
    } catch (err: any) {
      throw new Error(`Failed to read "${itemRef}" from macOS Keychain: ${err.message}`);
    }
  }

  private static resolveFromEnv(): ResolvedCredentials {
    return {
      username: process.env['EB_USERNAME']?.trim(),
      password: process.env['EB_PASSWORD']?.trim(),
      totp: process.env['EB_TOTP']?.trim(),
      account: process.env['EB_ACCOUNT']?.trim(),
      environment: process.env['EB_ENVIRONMENT']?.trim(),
    };
  }
}
