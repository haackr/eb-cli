import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Environment,
  baseurl,
  getShortEnv,
  getSubdomain,
  getEnvironment,
  getDisplayName,
  envMap,
  reverseEnvMap,
} from '../lib/eb-puppetmaster/index.js';

describe('Environment Mapping & Utilities (src/lib/eb-puppetmaster/index.ts)', () => {
  it('exports correct baseurl and environment enums', () => {
    assert.strictEqual(baseurl, 'e-builder.net');
    assert.strictEqual(Environment.US1, 'app');
    assert.strictEqual(Environment.US2, 'app-us2');
    assert.strictEqual(Environment.US3, 'app-us3');
    assert.strictEqual(Environment.US4, 'app-us4');
    assert.strictEqual(Environment.GOV, 'gov');
    assert.strictEqual(Environment.CA, 'app.ca');
  });

  describe('getShortEnv', () => {
    it('correctly maps subdomains to short environment names', () => {
      assert.strictEqual(getShortEnv('app'), 'us1');
      assert.strictEqual(getShortEnv('app-us2'), 'us2');
      assert.strictEqual(getShortEnv('app-us3'), 'us3');
      assert.strictEqual(getShortEnv('app-us4'), 'us4');
      assert.strictEqual(getShortEnv('gov'), 'gov');
      assert.strictEqual(getShortEnv('app.ca'), 'ca');
    });

    it('throws on unknown subdomain', () => {
      assert.throws(() => getShortEnv('unknown-subdomain'), /Unknown subdomain: unknown-subdomain/);
    });
  });

  describe('getSubdomain & getEnvironment', () => {
    it('correctly maps short names to subdomains', () => {
      assert.strictEqual(getSubdomain('us1'), 'app');
      assert.strictEqual(getSubdomain('us2'), 'app-us2');
      assert.strictEqual(getSubdomain('us3'), 'app-us3');
      assert.strictEqual(getSubdomain('us4'), 'app-us4');
      assert.strictEqual(getSubdomain('gov'), 'gov');
      assert.strictEqual(getSubdomain('ca'), 'app.ca');
    });

    it('returns Environment enum instance', () => {
      assert.strictEqual(getEnvironment('us1'), Environment.US1);
      assert.strictEqual(getEnvironment('gov'), Environment.GOV);
      assert.strictEqual(getEnvironment('ca'), Environment.CA);
    });

    it('throws on unknown short environment', () => {
      assert.throws(() => getSubdomain('eu1'), /Unknown environment: eu1/);
      assert.throws(() => getEnvironment('eu1'), /Unknown environment: eu1/);
    });
  });

  describe('getDisplayName', () => {
    it('returns human-readable environment labels', () => {
      assert.strictEqual(getDisplayName('us1'), 'US-1');
      assert.strictEqual(getDisplayName('us2'), 'US-2');
      assert.strictEqual(getDisplayName('us3'), 'US-3');
      assert.strictEqual(getDisplayName('us4'), 'US-4');
      assert.strictEqual(getDisplayName('gov'), 'GOV');
      assert.strictEqual(getDisplayName('ca'), 'CA');
    });

    it('throws on unknown short environment', () => {
      assert.throws(() => getDisplayName('stage'), /Unknown environment: stage/);
    });
  });

  it('maintains reciprocal maps', () => {
    for (const [short, sub] of Object.entries(envMap)) {
      assert.strictEqual(reverseEnvMap[sub], short);
    }
  });
});
