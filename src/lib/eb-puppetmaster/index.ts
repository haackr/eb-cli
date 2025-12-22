export * from './auth.js';
export * from './budgetitem.js';
export * from './browser-manager.js';

export enum Environment {
  US1 = 'app',
  US2 = 'app-us2',
  US3 = 'app-us3',
  US4 = 'app-us4',
  GOV = 'gov',
  CA = 'app.ca',
}

export const baseurl = 'e-builder.net';

export const envMap: Record<string, string> = {
  us1: 'app',
  us2: 'app-us2',
  us3: 'app-us3',
  us4: 'app-us4',
  gov: 'gov',
  ca: 'app.ca',
};

export const reverseEnvMap: Record<string, string> = {
  app: 'us1',
  'app-us2': 'us2',
  'app-us3': 'us3',
  'app-us4': 'us4',
  gov: 'gov',
  'app.ca': 'ca',
};

export function getShortEnv(subdomain: string): string {
  const short = reverseEnvMap[subdomain];
  if (!short) throw new Error(`Unknown subdomain: ${subdomain}`);
  return short;
}

export function getSubdomain(shortEnv: string): string {
  const subdomain = envMap[shortEnv];
  if (!subdomain) throw new Error(`Unknown environment: ${shortEnv}`);
  return subdomain;
}

export function getEnvironment(shortEnv: string): Environment {
  return getSubdomain(shortEnv) as Environment;
}

export function getDisplayName(shortEnv: string): string {
  switch (shortEnv) {
    case 'us1':
      return 'US-1';
    case 'us2':
      return 'US-2';
    case 'us3':
      return 'US-3';
    case 'us4':
      return 'US-4';
    case 'gov':
      return 'GOV';
    case 'ca':
      return 'CA';
    default:
      throw new Error(`Unknown environment: ${shortEnv}`);
  }
}
