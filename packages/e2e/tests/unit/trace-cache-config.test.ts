/** Cache config resolution and the staged-write settlement. */

import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createAgentCacheContext, settleStagedTraces } from '../../src/cache/context.ts';
import { FileCacheStore } from '../../src/cache/store.ts';
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

/** The step every staged entry here was recorded for, whole. */
const STEP = {
  testId: 'tests/a.e2e.ts::a',
  targetId: 'web',
  instructionDigest: 'd'.repeat(64),
  paramsDigest: 'e'.repeat(64),
  callIndex: 0,
  agent: 'default',
};

const trace = (summary: string): ActionTrace => ({
  actions: [{ name: 'tap', summary: 'tap button "X"', target: { role: 'button', name: 'X' } }],
  executor: { name: 'test' },
  recordedFor: STEP,
  summary,
});

describe('cache config resolution', () => {
  it('is opt-out: unset defaults to read-write with the file store under .e2e/cache, or the configured dir', () => {
    const resolved = resolve(APP).cache;
    expect(resolved.mode).toBe('read-write');
    expect(resolved.store).toBeUndefined();
    expect(resolved.dir).toBe(path.join(ROOT, '.e2e', 'cache'));
    expect(resolve({ ...APP, cache: { dir: 'shared' } }).cache.dir).toBe(path.join(ROOT, 'shared'));
    expect(resolve({ ...APP, cache: { mode: 'read-only' } }).cache.mode).toBe('read-only');
    expect(resolve({ ...APP, cache: { mode: 'off' } }).cache.mode).toBe('off');
  });

  it('lets the --no-cache override win over the config, even in CI', () => {
    expect(resolve({ ...APP, cache: 'read-write' }, BASE_ENV, { cache: 'off' }).cache.mode).toBe('off');
    expect(resolve(APP, { ...BASE_ENV, CI: '1' }, { cache: 'off' }).cache.mode).toBe('off');
  });

  it('takes the directory from --cache-dir, then E2E_CACHE_DIR, then cache.dir, from the project root', () => {
    const configured = { ...APP, cache: { mode: 'read-only' as const, dir: 'configured' } };
    const env = { ...BASE_ENV, E2E_CACHE_DIR: '../shared/e2e' };
    expect(resolve(configured, env, { cacheDir: '/abs/flag' }).cache.dir).toBe(path.resolve('/abs/flag'));
    expect(resolve(configured, env).cache.dir).toBe(path.resolve(ROOT, '../shared/e2e'));
    expect(resolve(configured, { ...BASE_ENV, E2E_CACHE_DIR: ' ' }).cache.dir).toBe(path.join(ROOT, 'configured'));
    expect(resolve(APP, env).cache.dir).toBe(path.resolve(ROOT, '../shared/e2e'));
  });

  it('leaves the mode to the config and --no-cache when the directory is overridden', () => {
    const env = { ...BASE_ENV, E2E_CACHE_DIR: '/abs/shared' };
    expect(resolve({ ...APP, cache: 'read-only' }, env).cache).toMatchObject({ mode: 'read-only', dir: path.resolve('/abs/shared') });
    expect(resolve(APP, env, { cache: 'off', cacheDir: 'flag' }).cache).toMatchObject({ mode: 'off', dir: path.join(ROOT, 'flag') });
    expect(resolve(APP, { ...env, CI: '1' }).cache.mode).toBe('read-only');
  });

  it('refuses --cache-dir beside a cache.store and ignores E2E_CACHE_DIR there, even one the output would overlap', () => {
    const stored = { cache: { store: memoryStore() } };
    expect(() => resolve(stored, BASE_ENV, { cacheDir: 'shared' })).toThrow(
      '--cache-dir names a file store directory, but cache.store replaces the file store; drop one',
    );
    expect(resolve(stored, { ...BASE_ENV, E2E_CACHE_DIR: '.e2e' }).cache).toMatchObject({ store: stored.cache.store, dir: path.join(ROOT, '.e2e', 'cache') });
  });

  it('reads a leading ~ in --cache-dir and E2E_CACHE_DIR as the home directory', () => {
    expect(resolve(APP, { ...BASE_ENV, E2E_CACHE_DIR: '~/x' }).cache.dir).toBe(path.join(os.homedir(), 'x'));
    expect(resolve(APP, BASE_ENV, { cacheDir: '~' }).cache.dir).toBe(os.homedir());
    expect(resolve(APP, BASE_ENV, { cacheDir: '~x' }).cache.dir).toBe(path.join(ROOT, '~x'));
  });

  it('rejects a blank --cache-dir, and an output the overridden cache directory overlaps', () => {
    expect(() => resolve(APP, BASE_ENV, { cacheDir: ' ' })).toThrow('--cache-dir must be a non-empty path');
    expect(() => resolve(APP, { ...BASE_ENV, E2E_CACHE_DIR: '.e2e' })).toThrow('output ".e2e" (the default) is the cache directory .e2e or inside it');
    expect(() => resolve(APP, BASE_ENV, { cacheDir: '.e2e/results/cache' })).toThrow(
      'output ".e2e" (the default) would hold --cache-dir .e2e/results/cache under results/, which the run owns; move --cache-dir or the output',
    );
  });

  it('demotes only an unset mode in CI; an explicit read-write or off is honored', () => {
    const ci = { ...BASE_ENV, CI: '1' };
    expect(resolve(APP, ci).cache.mode).toBe('read-only');
    expect(resolve({ ...APP, cache: 'off' }, ci).cache.mode).toBe('off');
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

  it('names a cache directory outside the project without asking for a commit', () => {
    expect(adviceFor({}, { cacheStrict: true, cacheDir: '/shared/e2e' })).toBe(
      `re-record it with a read-write run without --strict-cache; the run writes the new entry under ${path.resolve('/shared/e2e').split(path.sep).join('/')}`,
    );
  });

  it('points at the configured store rather than a directory when a custom store holds the entries', () => {
    expect(adviceFor({ cache: { strict: true, store: memoryStore() } })).toBe(
      're-record it with a read-write run with cache.strict set to false; the run writes the new entry to the configured cache.store',
    );
  });
});

describe('settleStagedTraces', () => {
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
    await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect([...store.entries.keys()]).toEqual([KEY_A]);
    expect(context.staged).toHaveLength(0);
  });

  it('writes nothing when no verification step ever passed', async () => {
    const store = memoryStore();
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('unchecked'), stepIndex: 1 });
    await settleStagedTraces(context, { lastVerifiedStepIndex: -1, implicatesUnconfirmed: true });
    expect(store.entries.size).toBe(0);
  });

  it('confirms traces followed by a later passed verification and evicts the implicated one', async () => {
    const store = memoryStore();
    store.entries.set(KEY_B, JSON.stringify(buildTraceEntry(trace('stale good flow'))));
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('confirmed'), stepIndex: 1 });
    context.staged.push({ kind: 'write', keyHash: KEY_B, trace: trace('implicated'), stepIndex: 3 });
    await settleStagedTraces(context, { lastVerifiedStepIndex: 3, implicatesUnconfirmed: true });
    expect(store.entries.has(KEY_A)).toBe(true);
    expect(store.entries.has(KEY_B)).toBe(false);
  });

  it('leaves a confirmed kept entry exactly as stored and evicts an unconfirmed one', async () => {
    const store = memoryStore();
    const stored = JSON.stringify(buildTraceEntry(trace('replayed flow')));
    store.entries.set(KEY_A, stored);
    store.entries.set(KEY_B, stored);
    const context = contextWith(store);
    context.staged.push({ kind: 'keep', keyHash: KEY_A, stepIndex: 1, recordedFor: STEP });
    context.staged.push({ kind: 'keep', keyHash: KEY_B, stepIndex: 3, recordedFor: STEP });
    const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    // The same bytes, createdAt included: a replay is not a rewrite.
    expect(store.entries.get(KEY_A)).toBe(stored);
    expect(store.entries.has(KEY_B)).toBe(false);
    expect([...writes]).toEqual([[1, 'kept'], [3, 'evicted']]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not report default-store eviction when the entry directory denies deletion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cache-delete-'));
    try {
      const store = new FileCacheStore({ directory, maxBytes: 1_048_576, writable: true });
      await store.write(KEY_B, trace('stale trailing flow'));
      const entryPath = path.join(directory, `${KEY_B}.json`);
      const before = await readFile(entryPath, 'utf8');
      await chmod(directory, 0o500);
      const context = contextWith(store);
      context.staged.push({ kind: 'keep', keyHash: KEY_B, stepIndex: 3, recordedFor: STEP });
      const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
      expect(await readFile(entryPath, 'utf8')).toBe(before);
      expect(writes.get(3)).toBe('unconfirmed');
      await expect(store.delete('c'.repeat(64))).resolves.toBeUndefined();
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not report an eviction when a custom store rejects deletion, and still settles other entries', async () => {
    const store = memoryStore();
    const stored = JSON.stringify(buildTraceEntry(trace('replayed flow')));
    store.entries.set(KEY_B, stored);
    const context = contextWith({ ...store, delete: async () => { throw new Error('store unavailable'); } });
    context.staged.push({ kind: 'keep', keyHash: KEY_B, stepIndex: 3, recordedFor: STEP });
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('confirmed'), stepIndex: 1 });
    const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect(store.entries.get(KEY_B)).toBe(stored);
    expect(writes.get(3)).toBe('unconfirmed');
    expect(writes.get(1)).toBe('saved');
    expect(store.entries.has(KEY_A)).toBe(true);
  });

  it('reports a new recording as unconfirmed when a custom store rejects its deletion', async () => {
    const context = contextWith({ ...memoryStore(), delete: async () => { throw new Error('store unavailable'); } });
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('unconfirmed'), stepIndex: 3 });
    const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect([...writes]).toEqual([[3, 'unconfirmed']]);
  });

  it('leaves a confirmed kept entry that records no key context as stored, so a committed cache stays clean', async () => {
    const store = memoryStore();
    const stored = JSON.stringify(buildTraceEntry({ ...trace('replayed flow'), recordedFor: STEP }));
    store.entries.set(KEY_A, stored);
    const context = contextWith(store);
    context.staged.push({ kind: 'keep', keyHash: KEY_A, stepIndex: 1, recordedFor: STEP });
    const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect(store.entries.get(KEY_A)).toBe(stored);
    expect(writes.get(1)).toBe('kept');
  });

  it('completes the provenance of a confirmed kept entry recorded before the occurrence fields, and nothing else', async () => {
    const store = memoryStore();
    const { paramsDigest: _params, callIndex: _index, agent: _agent, ...legacy } = STEP;
    const recorded = { ...trace('replayed flow'), recordedFor: legacy };
    store.entries.set(KEY_A, JSON.stringify(buildTraceEntry(recorded)));
    const context = contextWith(store);
    context.staged.push({ kind: 'keep', keyHash: KEY_A, stepIndex: 1, recordedFor: STEP });
    await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: true });
    expect(readTraceEntry(JSON.parse(store.entries.get(KEY_A)!))?.payload).toEqual({ ...recorded, recordedFor: STEP });
  });

  it('writes what was confirmed and leaves every unconfirmed entry as stored when the failure implicates nothing', async () => {
    const KEY_C = 'c'.repeat(64);
    const store = memoryStore();
    const stored = JSON.stringify(buildTraceEntry(trace('recorded flow')));
    store.entries.set(KEY_B, stored);
    store.entries.set(KEY_C, stored);
    const context = contextWith(store);
    context.staged.push({ kind: 'write', keyHash: KEY_A, trace: trace('confirmed'), stepIndex: 1 });
    context.staged.push({ kind: 'write', keyHash: KEY_B, trace: trace('re-recorded, unconfirmed'), stepIndex: 3 });
    context.staged.push({ kind: 'keep', keyHash: KEY_C, stepIndex: 4, recordedFor: STEP });
    const writes = await settleStagedTraces(context, { lastVerifiedStepIndex: 2, implicatesUnconfirmed: false });
    expect(store.entries.has(KEY_A)).toBe(true);
    expect(store.entries.get(KEY_B)).toBe(stored);
    expect(store.entries.get(KEY_C)).toBe(stored);
    expect([...writes]).toEqual([[1, 'saved'], [3, 'unconfirmed'], [4, 'unconfirmed']]);
  });

  it('claims a key per agent and per agent context, so one agent never replays another\'s recording', () => {
    const fresh = () => contextWith(memoryStore());
    const buyer = fresh().claimKey('act', 'approve the order', undefined, { name: 'buyer', context: undefined }).keyHash;
    const admin = fresh().claimKey('act', 'approve the order', undefined, { name: 'admin', context: undefined }).keyHash;
    const monthly = fresh().claimKey('act', 'approve the order', undefined, { name: 'buyer', context: 'Monthly' }).keyHash;
    expect(new Set([buyer, admin, monthly]).size).toBe(3);
    expect(fresh().claimKey('act', 'approve the order', undefined, { name: 'buyer', context: undefined }).keyHash).toBe(buyer);
    // Another agent calling the same instruction first does not renumber this agent's occurrence.
    const shared = fresh();
    shared.claimKey('act', 'approve the order', undefined, { name: 'admin', context: undefined });
    expect(shared.claimKey('act', 'approve the order', undefined, { name: 'buyer', context: undefined }).keyHash).toBe(buyer);
  });

  it('claims distinct key hashes per occurrence of the same signature', () => {
    const context = contextWith(memoryStore());
    const agent = { name: 'default', context: undefined };
    const first = context.claimKey('act', 'open billing', undefined, agent).keyHash;
    const repeat = context.claimKey('act', 'open billing', undefined, agent).keyHash;
    const other = context.claimKey('act', 'open billing', { fast: true }, agent).keyHash;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeat).not.toBe(first);
    expect(other).not.toBe(first);
  });
});
