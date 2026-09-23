/** trace-1 key identity. */

import { describe, expect, it } from 'vitest';
import {
  buildTraceCacheKey,
  createCallIndexer,
  engineCompatibilityVersion,
  instructionDigest,
  normalizeInstruction,
  paramsDigest,
  traceCacheKeyHash,
  traceCallSignature,
  type CacheTargetIdentity,
} from '../../src/cache/identity.ts';

const target: CacheTargetIdentity = {
  targetId: 'web',
  platform: 'web',
  engineName: 'playwright',
  engineVersion: '1.61.1',
  spiVersion: 1,
  appIdentity: 'a'.repeat(64),
};

describe('instruction identity', () => {
  it('normalizes line endings, NFC, and outer whitespace only', () => {
    expect(normalizeInstruction('  open billing\r\n')).toBe('open billing');
    expect(instructionDigest('open  billing')).not.toBe(instructionDigest('open billing'));
    expect(instructionDigest('café')).toBe(instructionDigest('café'));
  });
});

describe('params identity', () => {
  it('digests missing params as the empty object, independent of key order', () => {
    expect(paramsDigest(undefined)).toBe(paramsDigest({}));
    expect(paramsDigest({ a: 1, b: 2 })).toBe(paramsDigest({ b: 2, a: 1 }));
    expect(paramsDigest({ a: 1 })).not.toBe(paramsDigest({ a: 2 }));
  });
});

describe('engineCompatibilityVersion', () => {
  it('keeps major.minor and passes odd versions through', () => {
    expect(engineCompatibilityVersion('1.61.1')).toBe('1.61');
    expect(engineCompatibilityVersion('2.0')).toBe('2.0');
    expect(engineCompatibilityVersion('1.2.3-beta.1')).toBe('1.2');
    expect(engineCompatibilityVersion('nightly')).toBe('nightly');
  });
});

describe('createCallIndexer', () => {
  it('counts occurrences per signature, not per attempt', () => {
    const index = createCallIndexer();
    const open = traceCallSignature('act', 'open billing', undefined);
    const upgrade = traceCallSignature('act', 'upgrade the plan', undefined);
    expect(index(open)).toBe(0);
    expect(index(upgrade)).toBe(0);
    expect(index(open)).toBe(1);
    expect(index(traceCallSignature('act', 'open billing', { fast: true }))).toBe(0);
    expect(index(upgrade)).toBe(1);
  });
});

describe('traceCacheKeyHash', () => {
  const parts = {
    project: 'p'.repeat(64),
    testId: 'billing upgrade',
    target,
    signature: traceCallSignature('act', 'open billing', undefined),
    callIndex: 0,
    policyVersion: 'replay-policy/0',
  };

  it('is stable for identical parts and a driver patch release', () => {
    const hash = traceCacheKeyHash(buildTraceCacheKey(parts));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      traceCacheKeyHash(
        buildTraceCacheKey({ ...parts, target: { ...target, engineVersion: '1.61.9' } }),
      ),
    ).toBe(hash);
  });

  it.each([
    ['instruction', { signature: traceCallSignature('act', 'close billing', undefined) }],
    ['params', { signature: traceCallSignature('act', 'open billing', { fast: true }) }],
    ['call index', { callIndex: 1 }],
    ['test', { testId: 'other test' }],
    ['target', { target: { ...target, targetId: 'web-b' } }],
    ['driver minor', { target: { ...target, engineVersion: '1.62.0' } }],
    ['driver SPI version', { target: { ...target, spiVersion: 2 } }],
    ['policy version', { policyVersion: 'replay-policy/1' }],
  ])('changes when the %s changes', (_label, override) => {
    const hash = traceCacheKeyHash(buildTraceCacheKey(parts));
    expect(traceCacheKeyHash(buildTraceCacheKey({ ...parts, ...override }))).not.toBe(hash);
  });
});
