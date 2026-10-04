/** trace-1 key identity. */

import { describe, expect, it } from 'vitest';
import {
  buildTraceCacheKey,
  createCallIndexer,
  instructionDigest,
  keyContextChanges,
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
    agent: { name: 'default', context: 'The billing period is Monthly.' },
    policyVersion: 'replay-policy/0',
  };

  it('is stable for identical parts', () => {
    const hash = traceCacheKeyHash(buildTraceCacheKey(parts));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(traceCacheKeyHash(buildTraceCacheKey({ ...parts, target: { ...target } }))).toBe(hash);
  });

  it.each([
    ['instruction', { signature: traceCallSignature('act', 'close billing', undefined) }],
    ['params', { signature: traceCallSignature('act', 'open billing', { fast: true }) }],
    ['call index', { callIndex: 1 }],
    ['test', { testId: 'other test' }],
    ['target', { target: { ...target, targetId: 'web-b' } }],
    ['engine name', { target: { ...target, engineName: 'other' } }],
    ['engine SPI version', { target: { ...target, spiVersion: 2 } }],
    ['policy version', { policyVersion: 'replay-policy/1' }],
    ['agent', { agent: { ...parts.agent, name: 'admin' } }],
    ['agent context', { agent: { ...parts.agent, context: 'The billing period is Daily.' } }],
    ['agent context, to none', { agent: { name: 'default', context: undefined } }],
  ])('changes when the %s changes', (_label, override) => {
    const hash = traceCacheKeyHash(buildTraceCacheKey(parts));
    expect(traceCacheKeyHash(buildTraceCacheKey({ ...parts, ...override }))).not.toBe(hash);
  });

  // Every committed .e2e/cache entry is filed under this hash, so a change here misses all of them after an upgrade.
  // Change it only with a changeset saying so, and re-key the recordings committed under apps/.
  it('hashes a fixed key to the same value across releases', () => {
    expect(traceCacheKeyHash(buildTraceCacheKey(parts))).toBe('a108ef464ccf8c316bc7ae7766c586eae6a3bb2cc482654246854e58793c070a');
    const withParams = {
      ...parts,
      signature: traceCallSignature('act', 'upgrade to {{plan}}', { plan: 'Pro', seats: 3 }),
      callIndex: 2,
      agent: { name: 'buyer', context: undefined },
    };
    expect(traceCacheKeyHash(buildTraceCacheKey(withParams))).toBe('400b6e2625b0feb2483a87adcd90ab7ddb03a83ef47ed5409e57680cbb1d0caf');
  });

  it('keys the agent context by digest, never by its text', () => {
    const key = buildTraceCacheKey({ ...parts, agent: { name: 'buyer', context: 'Pay with <secret:card>.' } });
    expect(key.agent).toBe('buyer');
    expect(key.agentContextDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(key)).not.toContain('Pay with');
  });
});

describe('keyContextChanges', () => {
  const context = {
    cacheSchema: 'trace-1',
    policyVersion: 'conservative/6',
    project: 'p'.repeat(64),
    platform: 'web',
    engineName: 'web',
    engineVersion: '0.11',
    engineSpiVersion: 1,
    appIdentity: 'a'.repeat(64),
    agentContextDigest: 'c'.repeat(64),
  } as const;

  it('names what changed since the recording, with the values a reader can act on', () => {
    expect(keyContextChanges({ ...context, engineVersion: '0.10', appIdentity: 'b'.repeat(64) }, context)).toEqual([
      'the engine version (0.10 -> 0.11)',
      "the app's identity (app.identity, else its URL) or environment",
    ]);
  });

  it('says nothing for an entry that recorded no context, or the same one', () => {
    expect(keyContextChanges(undefined, context)).toEqual([]);
    expect(keyContextChanges(context, context)).toEqual([]);
  });
});
