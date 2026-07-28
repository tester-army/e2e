/** Cache key identity (spec 10-determinism.md, CACHE-IDENTITY-001). */

import { describe, expect, it } from 'vitest';
import {
  buildCacheKey,
  cacheKeyHash,
  cacheKeysEqual,
  cacheMethodForApi,
  inputDigest,
  instructionDigest,
  normalizeInstruction,
  projectIdentity,
  type CacheTargetIdentity,
} from '../../src/cache/index.ts';
import { specFixture } from '../helpers/cache-schema.ts';

const target: CacheTargetIdentity = {
  targetId: 'web',
  platform: 'web',
  driverId: 'playwright',
  driverVersion: '1.61.1',
  spiVersion: 1,
  appIdentity: 'a'.repeat(64),
};

function key(overrides: Partial<Parameters<typeof buildCacheKey>[0]> = {}) {
  return buildCacheKey({
    project: 'b'.repeat(64),
    testId: 'tests/login.e2e.ts::signs%20in',
    target,
    method: 'tap',
    callIndex: 0,
    instruction: 'the buy button',
    input: {},
    screenFingerprint: 'c'.repeat(64),
    policyVersion: 'policy-0.1',
    ...overrides,
  });
}

describe('instruction normalization', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeInstruction('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('applies NFC so equivalent spellings share one digest', () => {
    // "é" as one code point versus "e" plus a combining acute accent.
    expect(instructionDigest('\u00e9')).toBe(instructionDigest('e\u0301'));
  });

  it('trims outer whitespace without altering interior whitespace', () => {
    expect(normalizeInstruction('  the  buy   button \t\n')).toBe('the  buy   button');
    expect(instructionDigest('the buy button')).not.toBe(instructionDigest('the  buy  button'));
  });
});

describe('cacheable methods', () => {
  it('accepts every method in the cache-1 enum', () => {
    for (const api of ['tap', 'click', 'type', 'scroll', 'scrollTo', 'longPress', 'act']) {
      expect(cacheMethodForApi(`agent.${api}`)).toBe(api);
    }
  });

  it('rejects located actions outside the enum', () => {
    for (const api of ['press', 'select', 'hover', 'check', 'uncheck', 'upload', 'dragTo']) {
      expect(cacheMethodForApi(`agent.${api}`)).toBeUndefined();
    }
  });
});

describe('key digest', () => {
  it('matches the canonical spec fixture digest', () => {
    const fixture = specFixture('cache-v1.valid.json') as {
      key: Parameters<typeof cacheKeyHash>[0];
      keyHash: string;
    };
    expect(cacheKeyHash(fixture.key)).toBe(fixture.keyHash);
  });

  it('is stable across property insertion order', () => {
    const a = key();
    const reordered = Object.fromEntries(
      Object.entries(a).toReversed(),
    ) as unknown as typeof a;
    expect(cacheKeyHash(reordered)).toBe(cacheKeyHash(a));
    expect(cacheKeysEqual(reordered, a)).toBe(true);
  });

  it('changes when any identity field changes', () => {
    const baseline = cacheKeyHash(key());
    const variants = [
      key({ project: 'd'.repeat(64) }),
      key({ testId: 'tests/other.e2e.ts::signs%20in' }),
      key({ method: 'click' }),
      key({ callIndex: 1 }),
      key({ instruction: 'the sell button' }),
      key({ input: { durationMs: 500 } }),
      key({ screenFingerprint: 'e'.repeat(64) }),
      key({ policyVersion: 'policy-0.2' }),
      key({ target: { ...target, targetId: 'firefox' } }),
      key({ target: { ...target, platform: 'ios' } }),
      key({ target: { ...target, driverId: 'other' } }),
      key({ target: { ...target, driverVersion: '2.0.0' } }),
      key({ target: { ...target, appIdentity: 'f'.repeat(64) } }),
    ];
    const hashes = new Set(variants.map(cacheKeyHash));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(baseline)).toBe(false);
  });

  it('pins the spec and schema versions into every key', () => {
    expect(key()).toMatchObject({
      specVersion: '0.1',
      cacheSchema: 'cache-1',
      driverSpiVersion: 1,
    });
  });
});

describe('secret handling', () => {
  it('never lets a secret value reach a digest', () => {
    const withSecret = inputDigest({ sensitiveName: 'password', purpose: 'password' });
    const withValue = inputDigest({ value: 'hunter2', sensitive: false });
    expect(withSecret).not.toBe(withValue);
    // The digest is derived only from the name and purpose, so the same secret
    // used with a different value keeps one key.
    expect(withSecret).toBe(inputDigest({ purpose: 'password', sensitiveName: 'password' }));
  });
});

describe('project identity', () => {
  it('is the SHA-256 of the resolved project ID', () => {
    expect(projectIdentity('acme-web')).toMatch(/^[a-f0-9]{64}$/);
    expect(projectIdentity('acme-web')).not.toBe(projectIdentity('acme-api'));
  });
});
