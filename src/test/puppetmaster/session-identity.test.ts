import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Environment,
  cookieMatchesHost,
  cookieHeaderFor,
  decodeJwtClaims,
  getServerSessionId,
  getJwtClaims,
  parseGainsightIdentity,
  identifySession,
} from '../../lib/eb-puppetmaster/index.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;

// Shape captured from live US-2 (values replaced).
const HOME_HTML = `<script type="text/javascript">
        aptrinsic("identify",
            {
                //User Fields
                "id": "11111111-1111-1111-1111-111111111111",
                "emailDomain": "example.com",
                "isAccountAdmin": 'True',
            },
            {
                //Account Fields
                "id": "22222222-2222-2222-2222-222222222222",
                "name": "Acme \\"West\\" Account",
                "environment": "US2",
                "createdDate": '2026-11-11T18:30:56Z'
            });
</script>
<script>var accountID = '22222222-2222-2222-2222-222222222222';</script>`;

function us2Cookies(claims: Record<string, unknown>) {
  return [
    { name: 'JWT', value: jwt(claims), domain: '.app-us2.e-builder.net' },
    { name: '.ASPXAUTH', value: 'auth', domain: 'app-us2.e-builder.net' },
    { name: '_ga', value: 'ga', domain: '.e-builder.net' },
    { name: '__session__', value: 'tid', domain: '.id.trimble.com' },
  ];
}

type Call = { url: string; cookie: string };
function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, cookie: headers['cookie'] ?? '' });
    const route = routes[url];
    return route ? route() : new Response('', { status: 404 });
  };
}

describe('session identity (src/lib/eb-puppetmaster/session-identity.ts)', () => {
  it('matches cookie domains per RFC 6265 (host-only vs leading dot)', () => {
    assert.ok(
      cookieMatchesHost(
        { domain: '.app-us2.e-builder.net' } as any,
        'gateway.app-us2.e-builder.net',
      ),
    );
    assert.ok(
      cookieMatchesHost({ domain: '.e-builder.net' } as any, 'gateway.app-us2.e-builder.net'),
    );
    assert.ok(
      !cookieMatchesHost(
        { domain: 'app-us2.e-builder.net' } as any,
        'gateway.app-us2.e-builder.net',
      ),
    );
    assert.ok(
      cookieMatchesHost({ domain: 'app-us2.e-builder.net' } as any, 'app-us2.e-builder.net'),
    );
    assert.ok(!cookieMatchesHost({ domain: '.id.trimble.com' } as any, 'app-us2.e-builder.net'));
    assert.ok(!cookieMatchesHost({ domain: '.builder.net' } as any, 'app.e-builder.net'));
    assert.ok(!cookieMatchesHost({} as any, 'app.e-builder.net'));
  });

  it('never sends Trimble ID or host-only app cookies to the gateway', () => {
    const header = cookieHeaderFor(us2Cookies({}) as any, 'gateway.app-us2.e-builder.net');
    assert.match(header, /^JWT=/);
    assert.match(header, /_ga=ga/);
    assert.doesNotMatch(header, /ASPXAUTH|__session__/);
  });

  it('reads the ASP.NET session id for the environment host only', () => {
    const cookies = [
      { name: 'ASP.NET_SessionId', value: 'us1-sid', domain: 'app.e-builder.net' },
      { name: 'ASP.NET_SessionId', value: 'us2-sid', domain: 'app-us2.e-builder.net' },
    ];
    assert.strictEqual(getServerSessionId(Environment.US2, cookies as any), 'us2-sid');
    assert.strictEqual(getServerSessionId(Environment.US1, cookies as any), 'us1-sid');
    assert.strictEqual(getServerSessionId(Environment.US3, cookies as any), undefined);
  });

  it('decodes JWT claims and tolerates garbage', () => {
    const claims = decodeJwtClaims(
      jwt({ userName: 'jane@example.com', accountId: 'acct-1', userId: 'u-1', exp: 123 }),
    );
    assert.deepStrictEqual(claims, {
      userName: 'jane@example.com',
      accountId: 'acct-1',
      userId: 'u-1',
      exp: 123,
    });
    assert.strictEqual(decodeJwtClaims('not-a-jwt'), undefined);
    assert.strictEqual(decodeJwtClaims('a.!!!.c'), undefined);
  });

  it('prefers the JWT cookie scoped to the environment host', () => {
    const cookies = [
      { name: 'JWT', value: jwt({ userName: 'us1-user' }), domain: '.app.e-builder.net' },
      { name: 'JWT', value: jwt({ userName: 'us2-user' }), domain: '.app-us2.e-builder.net' },
    ];
    assert.strictEqual(getJwtClaims(Environment.US2, cookies as any)?.userName, 'us2-user');
    assert.strictEqual(getJwtClaims(Environment.US1, cookies as any)?.userName, 'us1-user');
  });

  it('parses the account from the Gainsight identify block', () => {
    assert.deepStrictEqual(parseGainsightIdentity(HOME_HTML), {
      accountName: 'Acme "West" Account',
      accountId: '22222222-2222-2222-2222-222222222222',
    });
    assert.deepStrictEqual(parseGainsightIdentity(`var accountID = 'abc';`), { accountId: 'abc' });
    assert.deepStrictEqual(parseGainsightIdentity('<html></html>'), {});
  });

  it('identifies from JWT + user-context without loading the home page', async () => {
    const calls: Call[] = [];
    const identity = await identifySession(
      Environment.US2,
      us2Cookies({ userName: 'jane@example.com', accountId: 'acct-1' }) as any,
      {
        fetchImpl: fakeFetch(
          {
            'https://gateway.app-us2.e-builder.net/api/branding/user-context': () =>
              Response.json({ accountName: 'Acme Production', name: 'Jane Doe' }),
          },
          calls,
        ),
      },
    );
    assert.deepStrictEqual(identity, {
      username: 'jane@example.com',
      accountId: 'acct-1',
      accountName: 'Acme Production',
      displayName: 'Jane Doe',
    });
    assert.strictEqual(calls.length, 1);
  });

  it('falls back to the home page when user-context fails', async () => {
    const calls: Call[] = [];
    const identity = await identifySession(
      Environment.US2,
      us2Cookies({ userName: 'jane@example.com' }) as any,
      {
        fetchImpl: fakeFetch(
          {
            'https://gateway.app-us2.e-builder.net/api/branding/user-context': () =>
              new Response('', { status: 401 }),
            'https://app-us2.e-builder.net/da2/Home/index2.aspx': () => new Response(HOME_HTML),
          },
          calls,
        ),
      },
    );
    assert.strictEqual(identity.username, 'jane@example.com');
    assert.strictEqual(identity.accountName, 'Acme "West" Account');
    assert.strictEqual(identity.accountId, '22222222-2222-2222-2222-222222222222');
    // The home page request carries the host-only auth cookie.
    assert.match(calls[1]!.cookie, /\.ASPXAUTH=auth/);
  });

  it('makes no requests when no cookies belong to e-Builder, and never throws', async () => {
    const calls: Call[] = [];
    const identity = await identifySession(Environment.US1, [{ name: 'x', value: '1' }] as any, {
      fetchImpl: fakeFetch({}, calls),
    });
    assert.deepStrictEqual(identity, {
      username: undefined,
      accountId: undefined,
      accountName: undefined,
      displayName: undefined,
    });
    assert.strictEqual(calls.length, 0);

    const failing = await identifySession(Environment.US2, us2Cookies({}) as any, {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.strictEqual(failing.accountName, undefined);
  });
});
