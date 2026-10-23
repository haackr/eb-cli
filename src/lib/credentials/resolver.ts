import { execSync, execFileSync } from 'child_process';
import type { CredentialProviderType, CredentialReference, ResolvedCredentials } from './types.js';

export class CredentialResolver {
  /**
   * Check if the CLI executable for the given provider is available on PATH.
   */
  public static isProviderAvailable(provider: CredentialProviderType): boolean {
    if (provider === 'env') return true;
    if (provider === '1password') {
      try {
        execSync('which op', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    if (provider === 'bitwarden') {
      try {
        execSync('which bw', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    if (provider === 'keychain') {
      try {
        execSync('which security', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
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
        const output = execFileSync('op', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const code = output.trim();
        return /^\d{6,8}$/.test(code) ? code : undefined;
      } catch {
        return undefined;
      }
    }

    if (ref.provider === 'bitwarden') {
      try {
        const output = execFileSync('bw', ['get', 'totp', ref.itemRef], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
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
      stdout = execFileSync('op', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
      stdout = execFileSync('bw', ['get', 'item', itemRef], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
      const stdout = execFileSync('security', ['find-generic-password', '-s', itemRef, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
