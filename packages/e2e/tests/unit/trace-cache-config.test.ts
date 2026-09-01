/** Cache config resolution and the staged-write settlement (RFC0001 cache-in). */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentCacheContext, flushStagedTraces } from '../../src/cache/context.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { ActionTrace, TraceCacheStore } from '../../src/types.ts';

const ROOT = path.resolve('/tmp/e2e-cache-config-tests');
const BASE_ENV = { APP_URL: 'http://localhost:4272' } as NodeJS.ProcessEnv;

function resolve(
  raw: Parameters<typeof resolveConfig>[0],
  env: NodeJS.ProcessEnv = BASE_ENV,
  cli: Parameters<typeof resolveConfig>[1]['cli'] = {},
) {
  return resolveConfig(raw, { projectRoot: ROOT, env, cli });
}

const APP = { app: { url: 'http://localhost:4272' } };

/** In-memory store standing in for a remote (Redis-shaped) implementation. */
function memoryStore(): TraceCacheStore & { entries: Map<string, ActionTrace> } {
  const entries = new Map<string, ActionTrace>();
  return {
    entries,
    writable: true,
    read: async (keyHash) => {
      const payload = entries.get(keyHash);
      return payload === undefined
        ? { status: 'miss' }
        : { status: 'hit', entry: { schemaVersion: 'trace-1', createdAt: '', payload }, bytes: 1 };
    },
    write: async (keyHash, payload) => {
      entries.set(keyHash, payload);
      return { bytes: 1 };
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

  it('forces read-write down to read-only in CI', () => {
    const resolved = resolve({ ...APP, cache: 'read-write' }, { ...BASE_ENV, CI: '1' }).cache;
    expect(resolved.mode).toBe('read-only');
  });

  it('rejects unknown modes, unknown keys, and non-store store values', () => {
    expect(() => resolve({ ...APP, cache: 'aggressive' as never })).toThrow(/cache mode/);
    expect(() => resolve({ ...APP, cache: { mode: 'off', ttl: 5 } as never })).toThrow(
      /unknown cache config key "ttl"/,
    );
    expect(() => resolve({ ...APP, cache: { store: { read: true } } as never })).toThrow(
      /cache.store must implement TraceCacheStore/,
    );
  });
});

describe('flushStagedTraces', () => {
  function contextWith(store: TraceCacheStore) {
    const context = createAgentCacheContext({
      cache: { mode: 'read-write', store, dir: '/unused' },
      projectId: 'p',
      testId: 't',
      target: {
        targetId: 'web',
        platform: 'web',
        driverId: 'playwright',
        driverVersion: '1.61.1',
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

  it('writes everything when the attempt passed', async () => {
    const store = memoryStore();
    const context = contextWith(store);
    context.staged.push({ keyHash: KEY_A, trace: trace('one'), stepIndex: 1 });
    context.staged.push({ keyHash: KEY_B, trace: trace('two'), stepIndex: 3 });
    await flushStagedTraces(context, 3, 'passed');
    expect([...store.entries.keys()].toSorted()).toEqual([KEY_A, KEY_B]);
    expect(context.staged).toHaveLength(0);
  });

  it('confirms traces followed by a later passed step and evicts the implicated one', async () => {
    const store = memoryStore();
    store.entries.set(KEY_B, trace('stale good flow'));
    const context = contextWith(store);
    context.staged.push({ keyHash: KEY_A, trace: trace('confirmed'), stepIndex: 1 });
    context.staged.push({ keyHash: KEY_B, trace: trace('implicated'), stepIndex: 3 });
    await flushStagedTraces(context, 3, 'failed');
    expect(store.entries.has(KEY_A)).toBe(true);
    expect(store.entries.has(KEY_B)).toBe(false);
  });

  it('neither writes nor evicts on an interrupted attempt', async () => {
    const store = memoryStore();
    store.entries.set(KEY_B, trace('still good'));
    const context = contextWith(store);
    context.staged.push({ keyHash: KEY_A, trace: trace('unwritten'), stepIndex: 1 });
    context.staged.push({ keyHash: KEY_B, trace: trace('kept'), stepIndex: 3 });
    await flushStagedTraces(context, 3, 'interrupted');
    expect(store.entries.has(KEY_A)).toBe(false);
    expect(store.entries.get(KEY_B)?.summary).toBe('still good');
    expect(context.staged).toHaveLength(0);
  });

  it('derives distinct key hashes per occurrence of the same signature', () => {
    const context = contextWith(memoryStore());
    const first = context.keyHashFor('act', 'open billing', undefined);
    const repeat = context.keyHashFor('act', 'open billing', undefined);
    const other = context.keyHashFor('act', 'open billing', { fast: true });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeat).not.toBe(first);
    expect(other).not.toBe(first);
  });
});
