import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  Environment,
  ChromeImportError,
  parseDevToolsActivePort,
  filterEBuilderCookies,
  cookiesForEnvironment,
  detectEnvironments,
  readChromeCookies,
} from '../../lib/eb-puppetmaster/index.js';

const JAR = [
  { name: '.ASPXAUTH', value: 'a2', domain: 'app-us2.e-builder.net' },
  { name: 'JWT', value: 'j2', domain: '.app-us2.e-builder.net' },
  { name: 'AWSALBAPP-0', value: 'lb', domain: 'app-us2.e-builder.net' },
  { name: '_ga', value: 'ga', domain: '.e-builder.net' },
  { name: '.ASPXAUTH', value: 'a1', domain: 'app.e-builder.net' },
  { name: '__session__', value: 'tid', domain: '.id.trimble.com' },
  { name: 'SID', value: 'g', domain: '.google.com' },
  { name: 'evil', value: 'x', domain: '.not-e-builder.net' },
];

describe('chrome import (src/lib/eb-puppetmaster/chrome-import.ts)', () => {
  it('parses DevToolsActivePort and rejects malformed files', () => {
    assert.strictEqual(
      parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'),
      'ws://127.0.0.1:9222/devtools/browser/abc-123',
    );
    assert.strictEqual(
      parseDevToolsActivePort('9222\r\n/devtools/browser/x'),
      'ws://127.0.0.1:9222/devtools/browser/x',
    );
    assert.strictEqual(parseDevToolsActivePort('9222\n'), undefined);
    assert.strictEqual(parseDevToolsActivePort('nope\n/devtools/browser/x'), undefined);
    assert.strictEqual(parseDevToolsActivePort('70000\n/devtools/browser/x'), undefined);
    assert.strictEqual(parseDevToolsActivePort('9222\n/json/version'), undefined);
  });

  it('keeps only e-Builder cookies from the whole jar', () => {
    assert.deepStrictEqual(
      filterEBuilderCookies(JAR).map((c) => `${c.name}@${c.domain}`),
      [
        '.ASPXAUTH@app-us2.e-builder.net',
        'JWT@.app-us2.e-builder.net',
        'AWSALBAPP-0@app-us2.e-builder.net',
        '_ga@.e-builder.net',
        '.ASPXAUTH@app.e-builder.net',
      ],
    );
  });

  it('detects environments from host-scoped auth cookies only', () => {
    assert.deepStrictEqual(detectEnvironments(JAR), [Environment.US1, Environment.US2]);
    assert.deepStrictEqual(
      detectEnvironments([{ name: '_ga', value: '', domain: '.e-builder.net' }]),
      [],
    );
    assert.deepStrictEqual(
      detectEnvironments([{ name: 'JWT', value: '', domain: '.app.ca.e-builder.net' }]),
      [Environment.CA],
    );
  });

  it('scopes cookies to one environment (app + gateway hosts)', () => {
    assert.deepStrictEqual(
      cookiesForEnvironment(Environment.US2, filterEBuilderCookies(JAR)).map((c) => c.value),
      ['a2', 'j2', 'lb', 'ga'],
    );
    assert.deepStrictEqual(
      cookiesForEnvironment(Environment.US1, filterEBuilderCookies(JAR)).map((c) => c.value),
      ['ga', 'a1'],
    );
  });

  describe('readChromeCookies', () => {
    let dataDir: string;
    const portFile = () => path.join(dataDir, 'DevToolsActivePort');
    const running = async () => true;

    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-chrome-import-test-'));
    });
    afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    function fakeBrowser(cookies = JAR) {
      const state = { disconnected: false, closed: false };
      const browser: any = {
        cookies: async () => cookies,
        disconnect: async () => {
          state.disconnected = true;
        },
        close: async () => {
          state.closed = true;
        },
      };
      return { browser, state };
    }

    it('connects to the advertised endpoint, filters cookies, and only disconnects', async () => {
      fs.writeFileSync(portFile(), '9333\n/devtools/browser/id-1\n');
      const { browser, state } = fakeBrowser();
      const endpoints: string[] = [];
      let approvals = 0;
      const cookies = await readChromeCookies({
        chromeDataDir: dataDir,
        isRunning: running,
        onAwaitingApproval: () => approvals++,
        connect: async (endpoint) => {
          endpoints.push(endpoint);
          return browser;
        },
      });
      assert.deepStrictEqual(endpoints, ['ws://127.0.0.1:9333/devtools/browser/id-1']);
      assert.strictEqual(approvals, 1);
      assert.deepStrictEqual([...new Set(cookies.map((c) => c.domain))].sort(), [
        '.app-us2.e-builder.net',
        '.e-builder.net',
        'app-us2.e-builder.net',
        'app.e-builder.net',
      ]);
      assert.strictEqual(state.disconnected, true);
      assert.strictEqual(state.closed, false, 'must never close the user’s Chrome');
    });

    it('leaves no timers behind after a successful read (process can exit)', async () => {
      fs.writeFileSync(portFile(), '9333\n/devtools/browser/id-1\n');
      const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      const before = timers();
      await readChromeCookies({
        chromeDataDir: dataDir,
        isRunning: running,
        timeoutMs: 60_000,
        connect: async () => fakeBrowser().browser,
      });
      assert.strictEqual(timers(), before);
    });

    it('waits through a stale port file until remote debugging is (re-)enabled', async () => {
      fs.writeFileSync(portFile(), '9222\n/devtools/browser/stale\n');
      let setup = 0;
      const { browser } = fakeBrowser();
      const tried: string[] = [];
      const cookies = await readChromeCookies({
        chromeDataDir: dataDir,
        isRunning: running,
        pollMs: 5,
        onNeedsSetup: () => {
          setup++;
          fs.writeFileSync(portFile(), '9222\n/devtools/browser/fresh\n');
        },
        connect: async (endpoint) => {
          tried.push(endpoint);
          if (endpoint.endsWith('stale')) throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
          return browser;
        },
      });
      assert.strictEqual(setup, 1);
      assert.deepStrictEqual(
        tried.map((t) => t.split('/').pop()),
        ['stale', 'fresh'],
      );
      assert.strictEqual(cookies.length, 5);
    });

    it('reports a declined approval prompt', async () => {
      fs.writeFileSync(portFile(), '9222\n/devtools/browser/x\n');
      await assert.rejects(
        readChromeCookies({
          chromeDataDir: dataDir,
          isRunning: running,
          connect: async () => {
            throw new Error('Unexpected server response: 403');
          },
        }),
        (e: any) => e instanceof ChromeImportError && e.code === 'declined',
      );
    });

    it('reports when Chrome is not running or remote debugging never gets enabled', async () => {
      await assert.rejects(
        readChromeCookies({ chromeDataDir: dataDir, isRunning: async () => false }),
        (e: any) => e.code === 'not_running',
      );
      await assert.rejects(
        readChromeCookies({
          chromeDataDir: dataDir,
          isRunning: running,
          timeoutMs: 30,
          pollMs: 5,
          connect: async () => {
            throw new Error('should not connect without a port file');
          },
        }),
        (e: any) => e.code === 'not_enabled' && /chrome:\/\/inspect/.test(e.message),
      );
      await assert.rejects(
        readChromeCookies({ chromeDataDir: path.join(dataDir, 'missing'), isRunning: running }),
        (e: any) => e.code === 'no_data_dir',
      );
    });

    it('times out while waiting for the approval prompt', async () => {
      fs.writeFileSync(portFile(), '9222\n/devtools/browser/x\n');
      await assert.rejects(
        readChromeCookies({
          chromeDataDir: dataDir,
          isRunning: running,
          timeoutMs: 30,
          connect: () => new Promise(() => {}),
        }),
        (e: any) => e.code === 'timeout',
      );
    });
  });
});
