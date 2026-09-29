/** Cache config resolution and the staged-write settlement. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentCacheContext, flushStagedTraces } from '../../src/cache/context.ts';
import { buildTraceEntry, readTraceEntry } from '../../src/cache/trace.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { ActionTrace, E2EConfig, CacheStore } from '../../src/types.ts';

const ROOT = path.resolve('/tmp/e2e-cache-config-tests');
const BASE_ENV = {} as NodeJS.ProcessEnv;

function resolve(
  raw: Partial<E2EConfig>,
  env: NodeJS.ProcessEnv = BASE_ENV,
  cli: Parameters<typeof resolveConfig>[1]['cli'] = {},
) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], ...raw }, { projectRoot: ROOT, env, cli });
}

const APP = {};

/**
 * In-memory store standing in for a remote (Redis-shaped) implementation:
 * the reference pattern a store author should copy — entries framed with
 * `buildTraceEntry` on write and validated with `readTraceEntry` on read.
 */
function memoryStore(): CacheStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    writable: true,
    read: async (keyHash) => {
      const serialized = entries.get(keyHash);
      if (serialized === undefined) return { status: 'miss' };
      const entry = readTraceEntry(JSON.parse(serialized));
      return entry === undefined
        ? { status: 'invalid', reason: 'not a trace-1 entry', bytes: serialized.length }
        : { status: 'hit', entry, bytes: serialized.length };
    },
    write: async (keyHash, payload) => {
      const serialized = JSON.stringify(buildTraceEntry(payload));
      entries.set(keyHash, serialized);
      return { bytes: serialized.length };
    },
    delete: async (keyHash) => {
      entries.delete(keyHash);
    },
  };
}

const trace = (summary: string): ActionTrace => ({
  actions: [{ name: 'tap', summary: 'tap button "X"', target: { role: 'button', name: 'X' } }],
  executor: { name: 'test' },
  summary,
});

describe('cache config resolution', () => {
  it('is opt-out: unset defaults to read-write with the file store under .e2e/cache', () => {
    const resolved = resolve(APP).cache;
    expect(resolved.mode).toBe('read-write');
    expect(resolved.store).toBeUndefined();
    expect(resolved.dir).toBe(path.join(ROOT, '.e2e', 'cache'));
  });

  it('defaults to read-only in CI and honors an explicit off', () => {
    expect(resolve(APP, { ...BASE_ENV, CI: '1' }).cache.mode).toBe('read-only');
    expect(resolve({ ...APP, cache: 'off' }).cache.mode).toBe('off');
    expect(resolve({ ...APP, cache: 'off' }, { ...BASE_ENV, CI: '1' }).cache.mode).toBe('off');
  });

  it('lets the --no-cache override win over the config, even in CI', () => {
    expect(resolve({ ...APP, cache: 'read-write' }, BASE_ENV, { cache: 'off' }).cache.mode).toBe('off');
    expect(resolve(APP, { ...BASE_ENV, CI: '1' }, { cache: 'off' }).cache.mode).toBe('off');
  });

  it('accepts the string shorthand and the options object', () => {
    expect(resolve({ ...APP, cache: 'read-write' }).cache.mode).toBe('read-write');
    const store = memoryStore();
    const resolved = resolve({ ...APP, cache: { mode: 'read-only', store, dir: 'shared' } }).cache;
    expect(resolved.mode).toBe('read-only');
    expect(resolved.store).toBe(store);
    expect(resolved.dir).toBe(path.join(ROOT, 'shared'));
  });

  it('demotes only an unset mode in CI; an explicit read-write is honored', () => {
    const ci = { ...BASE_ENV, CI: '1' };
    expect(resolve(APP, ci).cache.mode).toBe('read-only');
    expect(resolve({ ...APP, cache: { dir: 'shared' } }, ci).cache.mode).toBe('read-only');
    expect(resolve({ ...APP, cache: 'read-write' }, ci).cache.mode).toBe('read-write');
    expect(resolve({ ...APP, cache: { mode: 'read-write' } }, ci).cache.mode).toBe('read-write');
    expect(resolve({ ...APP, cache: 'read-only' }, ci).cache.mode).toBe('read-only');
  });

  it('exempts a host-supplied store from the CI clamp', () => {
    const store = memoryStore();
    const resolved = resolve(
      { ...APP, cache: { mode: 'read-write', store } },
      { ...BASE_ENV, CI: '1' },
    ).cache;
    expect(resolved.mode).toBe('read-write');
    expect(resolved.store).toBe(store);
  });

  it('is lenient unless the config or --strict-cache asks, and rejects a strict that is not a boolean', () => {
    expect(resolve(APP).cache.strict).toBe(false);
    expect(resolve({ cache: { strict: true } }).cache).toMatchObject({ mode: 'read-write', strict: { config: true, flag: false } });
    expect(resolve({ cache: 'read-only' }, BASE_ENV, { cacheStrict: true }).cache).toMatchObject({ mode: 'read-only', strict: { config: false, flag: true } });
    expect(() => resolve({ cache: { strict: 'yes' as unknown as boolean } })).toThrow(/cache\.strict must be a boolean/);
  });

  it('rejects unknown modes, unknown keys, and non-store store values', () => {
    expect(() => resolve({ ...APP, cache: 'aggressive' as never })).toThrow(/cache mode/);
    expect(() => resolve({ ...APP, cache: { mode: 'off', ttl: 5 } as never })).toThrow(
      /unknown cache config key "ttl"/,
    );
    expect(() => resolve({ ...APP, cache: { store: { read: true } } as never })).toThrow(
      /cache.store must implement CacheStore/,
    );
  });
});

describe('REPLAY_STALE advice', () => {
  const TARGET = {
    targetId: 'web',
    platform: 'web',
    engineName: 'playwright',
    engineVersion: '1.61.1',
    spiVersion: 1,
    appIdentity: 'a'.repeat(64),
  } as const;
  const adviceFor = (raw: Partial<E2EConfig>, cli: Parameters<typeof resolveConfig>[1]['cli'] = {}) => {
    const config = resolve(raw, BASE_ENV, cli);
    const context = createAgentCacheContext({
      cache: config.cache, projectRoot: config.projectRoot, projectId: 'p', testId: 't', target: TARGET, attemptIndex: 0,
    });
    return context?.strict === false || context?.strict === undefined ? undefined : context.strict.advice;
  };

  it('names the knob that turned strict on, and the cache directory relative to the project', () => {
    expect(adviceFor({})).toBeUndefined();
    expect(adviceFor({}, { cacheStrict: true })).toBe(
      're-record it with a read-write run without --strict-cache and commit the changed entry under .e2e/cache',
    );
    const configured = adviceFor({ cache: { strict: true, dir: 'recordings/replays' } });
    expect(configured).toBe(
      're-record it with a read-write run with cache.strict set to false and commit the changed entry under recordings/replays',
    );
    expect(adviceFor({ cache: { strict: true } }, { cacheStrict: true })).toContain('without --strict-cache and with cache.strict set to false');
  });

  it('points at the configured store rather than a directory when a custom store holds the entries', () => {
    expect(adviceFor({ cache: { strict: true, store: memoryStore() } })).toBe(
      're-record it with a read-write run with cache.strict set to false; the run writes the new entry to the configured cache.store',
    );
  });
});

describe('flushStagedTraces', () => {
  function contextWith(store: CacheStore) {
    const context = createAgentCacheContext({
      cache: { mode: 'read-write', store, dir: '/unused', strict: false },
      projectRoot: ROOT,
      projectId: 'p',
      testId: 't',
      target: {
        targetId: 'web',
        platform: 'web',
        engineName: 'playwright',
        engineVersion: '1.61.1',
        spiVersion: 1,
        appIdentity: 'a'.repeat(64),
      },
      attemptIndex: 0,
    });
    expect(context).toBeDefined();
    return context!;
  }

  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  it('writes only what a later verification step confirmed, even when the attempt passed', async () => {
    const store = memoryStore();
    store.entries.set(KEY_B, JSON.stringify(buildTraceEntry(trace('stale trailing flow'))));
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('one'), stepIndex: 1 });
    // A trailing act nothing asserted on: the attempt passing is not a check.
    context.staged.push({ kind: 'write', keyHash: KEY_B, trace: trace('two'), stepIndex: 3 });
    await flushStagedTraces(context, 2);
    expect([...store.entries.keys()]).toEqual([KEY_A]);
    expect(context.staged).toHaveLength(0);
  });

  it('writes nothing when no verification step ever passed', async () => {
    const store = memoryStore();
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('unchecked'), stepIndex: 1 });
    await flushStagedTraces(context, -1);
    expect(store.entries.size).toBe(0);
  });

  it('confirms traces followed by a later passed verification and evicts the implicated one', async () => {
    const store = memoryStore();
    store.entries.set(KEY_B, JSON.stringify(buildTraceEntry(trace('stale good flow'))));
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('confirmed'), stepIndex: 1 });
    context.staged.push({ kind: 'write', keyHash: KEY_B, trace: trace('implicated'), stepIndex: 3 });
    await flushStagedTraces(context, 3);
    expect(store.entries.has(KEY_A)).toBe(true);
    expect(store.entries.has(KEY_B)).toBe(false);
  });

  it('leaves a confirmed kept entry exactly as stored and evicts an unconfirmed one', async () => {
    const store = memoryStore();
    const stored = JSON.stringify(buildTraceEntry(trace('replayed flow')));
    store.entries.set(KEY_A, stored);
    store.entries.set(KEY_B, stored);
    const context = contextWith(store);
    context.staged.push({ kind: 'keep', keyHash: KEY_A, stepIndex: 1 });
    context.staged.push({ kind: 'keep', keyHash: KEY_B, stepIndex: 3 });
    await flushStagedTraces(context, 2);
    // The same bytes, createdAt included: a replay is not a rewrite.
    expect(store.entries.get(KEY_A)).toBe(stored);
    expect(store.entries.has(KEY_B)).toBe(false);
  });

  it('claims distinct key hashes per occurrence of the same signature', () => {
    const context = contextWith(memoryStore());
    const first = context.claimKeyHash('act', 'open billing', undefined);
    const repeat = context.claimKeyHash('act', 'open billing', undefined);
    const other = context.claimKeyHash('act', 'open billing', { fast: true });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeat).not.toBe(first);
    expect(other).not.toBe(first);
  });
});
