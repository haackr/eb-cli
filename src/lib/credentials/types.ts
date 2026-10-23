export type CredentialProviderType = '1password' | 'bitwarden' | 'keychain' | 'env';

export interface CredentialReference {
  provider: CredentialProviderType;
  itemRef: string;
  vault?: string | undefined;
}

/**
 * Internal credentials resolved in-memory during headless authentication.
 * These are NEVER returned to the AI agent or serialized to logs/JSON outputs.
 */
export interface ResolvedCredentials {
  username?: string | undefined;
  password?: string | undefined;
  totp?: string | undefined;
  account?: string | undefined;
  environment?: string | undefined;
}
