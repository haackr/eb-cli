/**
 * Works out who a set of e-Builder cookies belongs to (username, account name, account ID)
 * without driving a browser. Sources, most to least reliable:
 *
 * 1. The `JWT` cookie e-Builder sets on the app host: its claims carry `userName` and
 *    `accountId` (decoded locally, no request).
 * 2. `GET https://gateway.<app host>/api/branding/user-context`: the header app's own call;
 *    returns `accountName` and the user's display name. Authenticated by cookies alone.
 * 3. The Gainsight `aptrinsic("identify", user, account)` block in the home page HTML, which
 *    carries the account `id` and `name`.
 *
 * Every function here is best-effort and never throws.
 */
import type { Cookie } from 'puppeteer';
import type { Environment } from './index.js';

const baseurl = 'e-builder.net';

export type SessionIdentity = {
  username?: string | undefined;
  accountId?: string | undefined;
  accountName?: string | undefined;
  /** Display name of the user (e.g. "Jane Doe"); informational only. */
  displayName?: string | undefined;
};

export type JwtClaims = {
  userName?: string | undefined;
  accountId?: string | undefined;
  userId?: string | undefined;
  exp?: number | undefined;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type IdentifyOptions = {
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
};

type CookieLike = Pick<Cookie, 'name' | 'value'> & { domain?: string | undefined };

function str(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/** RFC 6265 domain match: a leading-dot domain covers subdomains; otherwise host-only. */
export function cookieMatchesHost(cookie: CookieLike, host: string): boolean {
  const raw = (cookie.domain ?? '').toLowerCase();
  if (!raw) return false;
  const h = host.toLowerCase();
  if (raw.startsWith('.')) {
    const d = raw.slice(1);
    return h === d || h.endsWith(`.${d}`);
  }
  return h === raw;
}

export function cookieHeaderFor(cookies: CookieLike[], host: string): string {
  return cookies
    .filter((c) => cookieMatchesHost(c, host))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * The ASP.NET session id for this environment's app host. It identifies one e-Builder login:
 * it stays the same across cookie refreshes (unlike `.ASPXAUTH`, which is reissued), and a new
 * login gets a new one.
 */
export function getServerSessionId(env: Environment, cookies: CookieLike[]): string | undefined {
  const appHost = `${env}.${baseurl}`;
  return cookies.find((c) => c.name === 'ASP.NET_SessionId' && cookieMatchesHost(c, appHost))
    ?.value;
}

export function decodeJwtClaims(token: string): JwtClaims | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return undefined;
    return {
      userName: str(claims.userName),
      accountId: str(claims.accountId),
      userId: str(claims.userId),
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Claims from the `JWT` cookie scoped to this environment's app host, if any. */
export function getJwtClaims(env: Environment, cookies: CookieLike[]): JwtClaims | undefined {
  const appHost = `${env}.${baseurl}`;
  const jwt =
    cookies.find((c) => c.name === 'JWT' && cookieMatchesHost(c, appHost)) ??
    cookies.find((c) => c.name === 'JWT');
  return jwt ? decodeJwtClaims(jwt.value) : undefined;
}

/** Account `id`/`name` from the Gainsight identify call embedded in e-Builder pages. */
export function parseGainsightIdentity(
  html: string,
): Pick<SessionIdentity, 'accountId' | 'accountName'> {
  const result: Pick<SessionIdentity, 'accountId' | 'accountName'> = {};
  const identify = html.match(
    /aptrinsic\(\s*["']identify["']\s*,\s*\{[\s\S]*?\}\s*,\s*\{([\s\S]*?)\}\s*\)/,
  );
  if (identify?.[1]) {
    const body = identify[1];
    const name = body.match(/["']name["']\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const id = body.match(/["']id["']\s*:\s*["']([^"']+)["']/);
    if (name?.[1]) {
      try {
        result.accountName = str(JSON.parse(`"${name[1]}"`));
      } catch {
        result.accountName = str(name[1]);
      }
    }
    if (id?.[1]) result.accountId = str(id[1]);
  }
  if (!result.accountId) {
    const fallback = html.match(/var\s+accountID\s*=\s*['"]([^'"]+)['"]/);
    if (fallback?.[1]) result.accountId = str(fallback[1]);
  }
  return result;
}

async function fetchWithCookies(
  url: string,
  cookies: CookieLike[],
  accept: string,
  origin: string,
  opts: IdentifyOptions,
): Promise<Response | undefined> {
  const host = new URL(url).hostname;
  const cookie = cookieHeaderFor(cookies, host);
  if (!cookie) return undefined;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return undefined;
  try {
    const res = await fetchImpl(url, {
      headers: { cookie, accept, origin },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return res.ok ? res : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUserContext(
  env: Environment,
  cookies: CookieLike[],
  opts: IdentifyOptions = {},
): Promise<Pick<SessionIdentity, 'accountName' | 'displayName'>> {
  const appHost = `${env}.${baseurl}`;
  const res = await fetchWithCookies(
    `https://gateway.${appHost}/api/branding/user-context`,
    cookies,
    'application/json',
    `https://${appHost}`,
    opts,
  );
  if (!res) return {};
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return { accountName: str(body['accountName']), displayName: str(body['name']) };
  } catch {
    return {};
  }
}

async function fetchHomeIdentity(
  env: Environment,
  cookies: CookieLike[],
  opts: IdentifyOptions,
): Promise<Pick<SessionIdentity, 'accountId' | 'accountName'>> {
  const appHost = `${env}.${baseurl}`;
  const res = await fetchWithCookies(
    `https://${appHost}/da2/Home/index2.aspx`,
    cookies,
    'text/html',
    `https://${appHost}`,
    opts,
  );
  if (!res) return {};
  try {
    return parseGainsightIdentity(await res.text());
  } catch {
    return {};
  }
}

/**
 * Identifies the user and account behind `cookies`. Pass cookies from a just-verified session
 * (e.g. `isLoggedIn().newCookies`) so the short-lived JWT is fresh. Never throws.
 */
export async function identifySession(
  env: Environment,
  cookies: CookieLike[],
  opts: IdentifyOptions = {},
): Promise<SessionIdentity> {
  const identity: SessionIdentity = {};
  const claims = getJwtClaims(env, cookies);
  identity.username = claims?.userName;
  identity.accountId = claims?.accountId;

  const ctx = await fetchUserContext(env, cookies, opts);
  identity.accountName = ctx.accountName;
  identity.displayName = ctx.displayName;

  if (!identity.accountName || !identity.accountId) {
    const home = await fetchHomeIdentity(env, cookies, opts);
    identity.accountName ??= home.accountName;
    identity.accountId ??= home.accountId;
  }
  return identity;
}
