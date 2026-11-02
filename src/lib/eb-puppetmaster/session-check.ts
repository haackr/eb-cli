/**
 * Why a session check concluded what it did. Only `redirected_to_login` proves the stored
 * cookies are dead; every other failure reason is transient or environmental and must never
 * cause a session to be invalidated or deleted.
 */
export type SessionCheckReason =
  | 'authenticated'
  | 'redirected_to_login'
  | 'network_error'
  | 'timeout'
  | 'server_error'
  | 'unknown';

export interface SessionCheckResult {
  isLoggedIn: boolean;
  reason: SessionCheckReason;
  errorMessage?: string | undefined;
  landedUrl?: string | undefined;
  newCookies: puppeteer.Cookie[];
}

const NETWORK_ERROR_PATTERN =
  /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/;

const SANDBOX_HINT =
  'If running inside an AI agent sandbox, re-run with network access enabled (e.g. BypassSandbox: true).';

/** Base class so callers can `instanceof` any classified session failure. */
export class SessionCheckError extends Error {
  public readonly code: string;
  public readonly reason: SessionCheckReason;
  public readonly landedUrl?: string | undefined;

  constructor(
    code: string,
    reason: SessionCheckReason,
    message: string,
    landedUrl?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = code;
    this.code = code;
    this.reason = reason;
    this.landedUrl = landedUrl;
    if (cause !== undefined) this.cause = cause;
  }
}

export class SessionExpiredError extends SessionCheckError {
  constructor(message: string, landedUrl?: string, cause?: unknown) {
    super('SessionExpiredError', 'redirected_to_login', message, landedUrl, cause);
  }
}

export class NetworkError extends SessionCheckError {
  constructor(message: string, landedUrl?: string, cause?: unknown) {
    super('NetworkError', 'network_error', message, landedUrl, cause);
  }
}

export class NavigationTimeoutError extends SessionCheckError {
  constructor(message: string, landedUrl?: string, cause?: unknown) {
    super('NavigationTimeoutError', 'timeout', message, landedUrl, cause);
  }
}

export class ServerError extends SessionCheckError {
  constructor(message: string, landedUrl?: string, cause?: unknown) {
    super('ServerError', 'server_error', message, landedUrl, cause);
  }
}

export class SessionUnverifiedError extends SessionCheckError {
  constructor(message: string, landedUrl?: string, cause?: unknown) {
    super('SessionUnverifiedError', 'unknown', message, landedUrl, cause);
  }
}

/**
 * Classifies a thrown navigation error. Returns null when the error is not a recognizable
 * network/timeout failure (callers should then fall back to inspecting the landed page).
 */
export function classifyNavigationError(err: unknown): 'network_error' | 'timeout' | null {
  if (!err) return null;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (NETWORK_ERROR_PATTERN.test(message)) return 'network_error';
  if (name === 'TimeoutError' || /Navigation timeout|Timeout .* exceeded/i.test(message)) {
    return 'timeout';
  }
  return null;
}

/**
 * True when a URL is an e-Builder login page or an external identity provider
 * (Trimble ID, PingFederate, Google, Microsoft, Okta) — i.e. proof the cookies were rejected.
 */
export function isLoginUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  if (
    host === 'id.trimble.com' ||
    host.endsWith('.id.trimble.com') ||
    host === 'accounts.google.com' ||
    host === 'login.microsoftonline.com' ||
    host.includes('pingfederate') ||
    host.includes('pingone') ||
    host.endsWith('.okta.com')
  ) {
    return true;
  }

  return (
    /(^|\/)login(\/|\.aspx|$)/.test(pathname) ||
    pathname.startsWith('/auth/') ||
    pathname.includes('loginsequence') ||
    pathname.includes('/signin')
  );
}

/** Detects an e-Builder login form rendered in place (no redirect). */
export async function pageShowsLoginForm(page: puppeteer.Page): Promise<boolean> {
  if (typeof page.evaluate !== 'function') return false;
  try {
    return await page.evaluate(() =>
      Boolean(
        document.querySelector(
          '#ctl00_ContentPlaceHolder1_txtUserName, #txtUserName, #txtUsername, input[name*="txtUserName"], input[name*="txtPassword"]',
        ),
      ),
    );
  } catch {
    return false;
  }
}

export function safePageUrl(page: puppeteer.Page | null | undefined): string | undefined {
  if (!page || typeof page.url !== 'function') return undefined;
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/** Converts a failed check result into the matching typed error with an actionable message. */
export function sessionCheckErrorFor(
  result: Pick<SessionCheckResult, 'reason' | 'errorMessage' | 'landedUrl'>,
  origin: string,
  cause?: unknown,
): SessionCheckError {
  const detail = result.errorMessage ? ` (${result.errorMessage})` : '';
  const notInvalidated = 'Session cookies were NOT invalidated.';
  switch (result.reason) {
    case 'redirected_to_login':
      return new SessionExpiredError(
        `Session has expired: e-Builder redirected to a login page${
          result.landedUrl ? ` (${result.landedUrl})` : ''
        }. Please log in again using 'eb login'.`,
        result.landedUrl,
        cause,
      );
    case 'network_error':
      return new NetworkError(
        `Cannot reach ${origin}${detail}. ${SANDBOX_HINT} ${notInvalidated}`,
        result.landedUrl,
        cause,
      );
    case 'timeout':
      return new NavigationTimeoutError(
        `Timed out reaching ${origin}${detail}. ${notInvalidated}`,
        result.landedUrl,
        cause,
      );
    case 'server_error':
      return new ServerError(
        `e-Builder returned a server error${detail}. ${notInvalidated}`,
        result.landedUrl,
        cause,
      );
    default:
      return new SessionUnverifiedError(
        `Could not verify the session is authenticated${
          result.landedUrl ? ` (landed on ${result.landedUrl})` : ''
        }${detail}. ${notInvalidated} Run 'eb session test' to diagnose.`,
        result.landedUrl,
        cause,
      );
  }
}
