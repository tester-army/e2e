/** Cache key identity (spec 10-determinism.md, CACHE-IDENTITY-001). */

import { describe, expect, it } from 'vitest';
import {
  buildCacheKey,
  cacheCallSignature,
  cacheKeyHash,
  createCallIndexer,
  driverCompatibilityVersion,
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
    signature: cacheCallSignature('tap', 'the buy button', {}),
    callIndex: 0,
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
  it('accepts every located action, because they all find a node the same way', () => {
    const methods = [
      'tap',
      'click',
      'type',
      'scroll',
      'scrollTo',
      'longPress',
      'act',
      'press',
      'hover',
      'select',
      'check',
      'uncheck',
      'dragTo',
      'upload',
    ];
    for (const api of methods) {
      expect(cacheMethodForApi(`agent.${api}`)).toBe(api);
    }
  });

  it('rejects a method that locates nothing', () => {
    // A judgment, an extraction, and a login have no located node to store.
    for (const api of ['assert', 'waitFor', 'extract', 'login']) {
      expect(cacheMethodForApi(`agent.${api}`)).toBeUndefined();
    }
  });
});

describe('key digest', () => {
  it('matches the canonical spec fixture digest', () => {
    const fixture = specFixture('cache-v1.key.json') as {
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
  });

  it('changes when any identity field changes', () => {
    const baseline = cacheKeyHash(key());
    const variants = [
      key({ project: 'd'.repeat(64) }),
      key({ testId: 'tests/other.e2e.ts::signs%20in' }),
      key({ signature: cacheCallSignature('click', 'the buy button', {}) }),
      key({ callIndex: 1 }),
      key({ signature: cacheCallSignature('tap', 'the sell button', {}) }),
      key({ signature: cacheCallSignature('tap', 'the buy button', { durationMs: 500 }) }),
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

describe('call occurrence index', () => {
  const tap = (instruction: string, input: Readonly<Record<string, unknown>> = {}) =>
    cacheCallSignature('tap', instruction, input);

  it('numbers repeats of the same call in order', () => {
    const next = createCallIndexer();
    expect(next(tap('the buy button'))).toBe(0);
    expect(next(tap('the buy button'))).toBe(1);
    expect(next(tap('the buy button'))).toBe(2);
  });

  it('counts each call independently, so an unrelated call cannot renumber it', () => {
    // The production failure this scoping exists to prevent: an optional
    // consent dialog that appears on some sessions and not others must not
    // change the number every later call is keyed under.
    const withDialog = createCallIndexer();
    withDialog(tap('the accept cookies button'));
    const withDialogIndex = withDialog(tap('the destination field'));

    const withoutDialog = createCallIndexer();
    const withoutDialogIndex = withoutDialog(tap('the destination field'));

    expect(withDialogIndex).toBe(withoutDialogIndex);
    expect(withDialogIndex).toBe(0);
  });

  it('separates calls that differ only by method or parameters', () => {
    const next = createCallIndexer();
    expect(next(cacheCallSignature('tap', 'the target', {}))).toBe(0);
    expect(next(cacheCallSignature('click', 'the target', {}))).toBe(0);
    expect(next(cacheCallSignature('tap', 'the target', { durationMs: 500 }))).toBe(0);
    expect(next(cacheCallSignature('tap', 'the target', {}))).toBe(1);
  });

  it('treats instructions that normalize alike as the same call', () => {
    const next = createCallIndexer();
    expect(next(tap('the buy button'))).toBe(0);
    expect(next(tap('  the buy button\r\n'))).toBe(1);
  });

  it('gives each attempt its own numbering', () => {
    expect(createCallIndexer()(tap('the buy button'))).toBe(0);
    expect(createCallIndexer()(tap('the buy button'))).toBe(0);
  });
});

describe('driver compatibility version', () => {
  it('keeps major and minor and drops the patch', () => {
    expect(driverCompatibilityVersion('1.61.1')).toBe('1.61');
    expect(driverCompatibilityVersion('1.61.0')).toBe('1.61');
    expect(driverCompatibilityVersion('1.61')).toBe('1.61');
  });

  it('drops prerelease and build metadata', () => {
    expect(driverCompatibilityVersion('1.61.1-beta.2')).toBe('1.61');
    expect(driverCompatibilityVersion('2.0.0+build7')).toBe('2.0');
  });

  it('separates a minor bump but not a patch bump', () => {
    const patch = key({ target: { ...target, driverVersion: '1.61.9' } });
    const minor = key({ target: { ...target, driverVersion: '1.62.0' } });
    expect(cacheKeyHash(patch)).toBe(cacheKeyHash(key()));
    expect(cacheKeyHash(minor)).not.toBe(cacheKeyHash(key()));
  });

  it('passes through a version it cannot parse', () => {
    expect(driverCompatibilityVersion('unknown')).toBe('unknown');
    expect(driverCompatibilityVersion('')).toBe('');
  });
});
