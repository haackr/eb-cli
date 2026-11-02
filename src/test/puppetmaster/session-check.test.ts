import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  classifyNavigationError,
  isLoginUrl,
  sessionCheckErrorFor,
  SessionExpiredError,
  NetworkError,
  NavigationTimeoutError,
  ServerError,
  isEBuilderAuthenticatedUrl,
  Environment,
} from '../../lib/eb-puppetmaster/index.js';

describe('Session check classification (src/lib/eb-puppetmaster/session-check.ts)', () => {
  describe('classifyNavigationError', () => {
    it('classifies Chromium DNS / connectivity failures as network_error', () => {
      for (const msg of [
        'net::ERR_NAME_NOT_RESOLVED at https://app-us3.e-builder.net/',
        'net::ERR_INTERNET_DISCONNECTED',
        'net::ERR_CONNECTION_REFUSED',
        'net::ERR_ADDRESS_UNREACHABLE',
        'getaddrinfo ENOTFOUND app-us3.e-builder.net',
      ]) {
        assert.strictEqual(classifyNavigationError(new Error(msg)), 'network_error', msg);
      }
    });

    it('classifies puppeteer TimeoutError as timeout', () => {
      const err = new Error('Navigation timeout of 90000 ms exceeded');
      err.name = 'TimeoutError';
      assert.strictEqual(classifyNavigationError(err), 'timeout');
    });

    it('returns null for unrelated errors', () => {
      assert.strictEqual(classifyNavigationError(new Error('boom')), null);
      assert.strictEqual(classifyNavigationError(undefined), null);
    });
  });

  describe('isLoginUrl', () => {
    it('detects e-Builder and identity-provider login pages', () => {
      for (const url of [
        'https://app-us3.e-builder.net/Login/Login.aspx?ReturnUrl=%2fda2',
        'https://app-us3.e-builder.net/da2/Login',
        'https://app-us3.e-builder.net/auth/Authenticate/LoginSequence.aspx',
        'https://id.trimble.com/ui/sign_in.html',
        'https://accounts.google.com/o/oauth2/auth',
        'https://sso.pingfederate.example.com/idp/SSO.saml2',
      ]) {
        assert.strictEqual(isLoginUrl(url), true, url);
      }
    });

    it('does not flag authenticated pages', () => {
      for (const url of [
        'https://app-us3.e-builder.net/da2/Home/index2.aspx',
        'https://app-us3.e-builder.net/da2/Reports/ReportResults.aspx?ReportID=abc',
        'about:blank',
        '',
      ]) {
        assert.strictEqual(isLoginUrl(url), false, url);
      }
    });

    it('is honored by isEBuilderAuthenticatedUrl', () => {
      assert.strictEqual(
        isEBuilderAuthenticatedUrl(
          new URL('https://app.e-builder.net/da2/Login.aspx'),
          Environment.US1,
        ),
        false,
      );
    });
  });

  describe('sessionCheckErrorFor', () => {
    const origin = 'https://app-us3.e-builder.net';

    it('maps each reason to a typed error with a code', () => {
      const cases: Array<[any, any, string]> = [
        ['redirected_to_login', SessionExpiredError, 'SessionExpiredError'],
        ['network_error', NetworkError, 'NetworkError'],
        ['timeout', NavigationTimeoutError, 'NavigationTimeoutError'],
        ['server_error', ServerError, 'ServerError'],
      ];
      for (const [reason, cls, code] of cases) {
        const err = sessionCheckErrorFor({ reason, errorMessage: 'x' }, origin);
        assert.ok(err instanceof cls, reason);
        assert.strictEqual(err.code, code);
        assert.strictEqual(err.reason, reason);
      }
    });

    it('includes the sandbox hint and non-invalidation note for network errors', () => {
      const err = sessionCheckErrorFor(
        { reason: 'network_error', errorMessage: 'net::ERR_NAME_NOT_RESOLVED' },
        origin,
      );
      assert.match(err.message, /Cannot reach https:\/\/app-us3\.e-builder\.net/);
      assert.match(err.message, /sandbox/i);
      assert.match(err.message, /NOT invalidated/);
    });

    it('only tells the user to log in again for real expiry', () => {
      assert.match(
        sessionCheckErrorFor({ reason: 'redirected_to_login' }, origin).message,
        /eb login/,
      );
      assert.doesNotMatch(
        sessionCheckErrorFor({ reason: 'timeout' }, origin).message,
        /Session has expired/,
      );
    });
  });
});
