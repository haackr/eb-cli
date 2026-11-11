import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Environment,
  isEBuilderHost,
  openVisiblePage,
  loginInBrowser,
  LoginWindowClosedError,
} from '../../lib/eb-puppetmaster/index.js';

/** A fake visible login browser whose single tab follows `urls` (one per poll). */
function fakeLoginBrowser(urls: string[], cookies: any[] = [{ name: 'c', value: '1' }]) {
  let i = 0;
  const visited: string[] = [];
  const page: any = {
    setDefaultNavigationTimeout: () => {},
    bringToFront: async () => {},
    setDefaultTimeout: () => {},
    goto: async (u: string) => {
      visited.push(u);
    },
    url: () => urls[Math.min(i++, urls.length - 1)],
    evaluate: async () => false,
    $: async () => null,
    $$: async () => [],
    exposeFunction: async () => {},
  };
  const browser: any = {
    connected: true,
    pages: async () => [page],
    newPage: async () => page,
    cookies: async () => cookies,
  };
  return { browser, page, visited };
}

describe('browser login (loginInBrowser)', () => {
  it('opens the e-Builder login page and returns cookies once signed in', async () => {
    const { browser, visited } = fakeLoginBrowser([
      'https://id.trimble.com/ui/sign_in.html',
      'https://app.e-builder.net/da2/Home/index2.aspx',
    ]);
    const result = await loginInBrowser(Environment.US1, { browser });
    assert.deepStrictEqual(visited, [
      'https://app.e-builder.net/auth/www/index.aspx?ReturnUrl=%2f',
    ]);
    assert.deepStrictEqual(result.cookies, [{ name: 'c', value: '1' }]);
    assert.strictEqual(result.env, Environment.US1);
  });

  it('reports the environment the user actually landed in', async () => {
    const { browser } = fakeLoginBrowser(['https://app-us2.e-builder.net/da2/Home/index2.aspx']);
    const result = await loginInBrowser(Environment.US1, { browser });
    assert.strictEqual(result.env, Environment.US2);
  });

  it('starts at the SSO URL when given and validates it', async () => {
    const { browser, visited } = fakeLoginBrowser([
      'https://app.e-builder.net/da2/Home/index2.aspx',
    ]);
    await loginInBrowser(Environment.US1, { browser, startUrl: 'https://idp.example.com/eb' });
    assert.deepStrictEqual(visited, ['https://idp.example.com/eb']);
    await assert.rejects(
      loginInBrowser(Environment.US1, { browser, startUrl: 'not a url' }),
      /absolute URL/,
    );
    await assert.rejects(
      loginInBrowser(Environment.US1, { browser, startUrl: 'file:///etc/passwd' }),
      /HTTP or HTTPS/,
    );
  });

  it('fails fast when the user closes the window', async () => {
    const closedAllTabs = fakeLoginBrowser(['https://id.trimble.com/ui/sign_in.html']);
    let polls = 0;
    const realPages = closedAllTabs.browser.pages;
    closedAllTabs.browser.pages = async () => (polls++ === 0 ? realPages() : []);
    await assert.rejects(
      loginInBrowser(Environment.US1, { browser: closedAllTabs.browser }),
      LoginWindowClosedError,
    );

    const disconnected = fakeLoginBrowser(['https://id.trimble.com/ui/sign_in.html']);
    disconnected.browser.connected = false;
    await assert.rejects(
      loginInBrowser(Environment.US1, { browser: disconnected.browser }),
      LoginWindowClosedError,
    );
  });

  it('isEBuilderHost checks the host, not the whole URL', () => {
    assert.ok(isEBuilderHost('https://app-us2.e-builder.net/da2/Home/index2.aspx'));
    assert.ok(isEBuilderHost('https://e-builder.net/'));
    assert.ok(
      !isEBuilderHost(
        'https://id.trimble.com/ui/sign_in.html?redirect_uri=https%3A%2F%2Fapp.e-builder.net%2Fauth',
      ),
    );
    assert.ok(!isEBuilderHost('https://e-builder.net.evil.example/'));
    assert.ok(!isEBuilderHost('https://note-builder.net/'));
    assert.ok(!isEBuilderHost('not a url'));
  });

  it('openVisiblePage opens a new tab and closes only the initial blank one', async () => {
    const closed: string[] = [];
    const mk = (name: string, url: string) => ({
      name,
      url: () => url,
      close: async () => {
        closed.push(name);
      },
      bringToFront: async () => {},
    });
    const initial = mk('initial', 'about:blank');
    const other = mk('other', 'https://example.com/');
    const fresh = mk('fresh', 'about:blank');
    const browser: any = { pages: async () => [initial, other], newPage: async () => fresh };
    const page: any = await openVisiblePage(browser);
    assert.strictEqual(page.name, 'fresh');
    assert.deepStrictEqual(closed, ['initial']);
  });
});
