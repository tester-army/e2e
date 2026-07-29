/** Cache storage (spec 10-determinism.md, CACHE-WRITE-001). */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileCacheStore,
  MAX_CACHE_WIRE_BYTES,
  buildCacheKey,
  cacheCallSignature,
  cacheKeyHash,
  createCacheStore,
  disabledCacheStore,
  type CacheTargetIdentity,
  type LocatePayload,
} from '../../src/cache/index.ts';
import { assertValidCacheEntry } from '../helpers/cache-schema.ts';

const target: CacheTargetIdentity = {
  targetId: 'web',
  platform: 'web',
  driverId: 'playwright',
  driverVersion: '1.61.1',
  spiVersion: 1,
  appIdentity: 'a'.repeat(64),
};

const payload: LocatePayload = {
  locator: {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: 'Buy', exact: true },
    },
  },
  expected: { role: 'button', name: 'Buy' },
};

const keyHash = cacheKeyHash(
  buildCacheKey({
    project: 'b'.repeat(64),
    testId: 'tests/buy.e2e.ts::buys',
    target,
    signature: cacheCallSignature('tap', 'the buy button', {}),
    callIndex: 0,
    screenFingerprint: 'c'.repeat(64),
    policyVersion: 'policy-0.2',
  }),
);

const directories: string[] = [];

async function store(options: { writable?: boolean; maxBytes?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-cache-'));
  directories.push(directory);
  return {
    directory,
    store: new FileCacheStore({
      directory,
      maxBytes: options.maxBytes ?? 262_144,
      writable: options.writable ?? true,
    }),
  };
}

afterEach(() => {
  directories.length = 0;
});

describe('round trip', () => {
  it('writes a schema-valid entry and reads it back', async () => {
    const { store: cache, directory } = await store();
    const written = await cache.write(keyHash, payload);
    expect(written?.bytes).toBeGreaterThan(0);

    const document = JSON.parse(
      await readFile(path.join(directory, `${keyHash}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assertValidCacheEntry(document);
    // The entry does not repeat its own key: the file name is the key digest.
    expect(document).not.toHaveProperty('key');
    expect(document).not.toHaveProperty('keyHash');

    const result = await cache.read(keyHash);
    expect(result.status).toBe('hit');
    expect(result.status === 'hit' && result.entry.payload).toEqual(payload);
  });

  it('reports a miss for an absent key', async () => {
    const { store: cache } = await store();
    expect((await cache.read(keyHash)).status).toBe('miss');
  });

  it('keeps one file per key, and rewrites in place', async () => {
    const { store: cache, directory } = await store();
    await cache.write(keyHash, payload);
    await cache.write(keyHash, payload);
    // Two writers only ever collide on a key when they are writing the same
    // locator, so last-write-wins is the outcome rather than a hazard.
    expect((await readdir(directory)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });

  it('survives concurrent writers to one key and leaves no debris', async () => {
    const { store: cache, directory } = await store();
    // Regression: temporary names derived from pid and clock collided when two
    // writers raced within a millisecond, and the first rename removed the
    // second's file. Only a unique temporary name makes lock-free writing safe.
    await Promise.all(Array.from({ length: 8 }, () => cache.write(keyHash, payload)));
    expect((await readdir(directory)).filter((n) => !n.endsWith('.json'))).toEqual([]);
    expect((await cache.read(keyHash)).status).toBe('hit');
  });
});

describe('reads fail closed', () => {
  async function poison(content: string) {
    const { store: cache, directory } = await store();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${keyHash}.json`), content, 'utf8');
    return cache;
  }

  it('ignores malformed JSON', async () => {
    const result = await (await poison('{ not json')).read(keyHash);
    expect(result.status).toBe('invalid');
  });

  it('ignores an entry whose locator is not admissible', async () => {
    const cache = await poison(
      JSON.stringify({
        schemaVersion: 'cache-1',
        kind: 'locate',
        payload: { locator: { kind: 'web-selector', selector: '#pwn' }, expected: { role: 'button' } },
      }),
    );
    expect((await cache.read(keyHash)).status).toBe('invalid');
  });

  it('ignores an oversized entry without reading it', async () => {
    const { store: cache, directory } = await store({ maxBytes: 1_024 });
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${keyHash}.json`), 'x'.repeat(2_048), 'utf8');
    const result = await cache.read(keyHash);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain('over the');
  });

  it('caps the configured limit at the wire ceiling', async () => {
    const { store: cache, directory } = await store({ maxBytes: MAX_CACHE_WIRE_BYTES * 4 });
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${keyHash}.json`),
      'x'.repeat(MAX_CACHE_WIRE_BYTES + 1),
      'utf8',
    );
    expect((await cache.read(keyHash)).status).toBe('invalid');
  });

  it('refuses a key hash that is not a bare digest', async () => {
    const { store: cache } = await store();
    for (const bad of ['../escape', `${keyHash}/../x`, 'NOTHEX', '']) {
      const result = await cache.read(bad);
      expect(result.status).toBe('invalid');
      expect(await cache.write(bad, payload)).toBeUndefined();
    }
  });

  it('ignores a directory in place of an entry', async () => {
    const { store: cache, directory } = await store();
    await mkdir(path.join(directory, `${keyHash}.json`), { recursive: true });
    expect((await cache.read(keyHash)).status).toBe('invalid');
  });

  it('replaces a poisoned entry on the next write', async () => {
    const cache = await poison('{ not json');
    await cache.write(keyHash, payload);
    expect((await cache.read(keyHash)).status).toBe('hit');
  });
});

describe('write modes', () => {
  it('never writes when not writable', async () => {
    const { store: cache, directory } = await store({ writable: false });
    expect(await cache.write(keyHash, payload)).toBeUndefined();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it('refuses to write an entry over the size limit', async () => {
    const { store: cache, directory } = await store({ maxBytes: 1_024 });
    const huge: LocatePayload = {
      ...payload,
      expected: { role: 'button', name: 'n'.repeat(4_096) },
    };
    expect(await cache.write(keyHash, huge)).toBeUndefined();
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

describe('store selection', () => {
  it('disables the cache entirely for mode off', async () => {
    const cache = createCacheStore({ mode: 'off', projectRoot: '/tmp', maxBytes: 1_024 });
    // `unusable` is both the disabled flag and the reason --debug reports, so a
    // store that cannot be used always says why.
    expect(cache.unusable).toBe('agent.cache mode is off');
    expect(cache.writable).toBe(false);
    expect((await cache.read(keyHash)).status).toBe('miss');
    expect(await cache.write(keyHash, payload)).toBeUndefined();
  });

  it('reports the caller-supplied reason on a disabled store', async () => {
    const cache = disabledCacheStore('retry attempts never consult the cache');
    expect(cache.unusable).toBe('retry attempts never consult the cache');
    expect((await cache.read(keyHash)).status).toBe('miss');
  });

  it('leaves a usable store with no reason to report', () => {
    const cache = createCacheStore({ mode: 'read-write', projectRoot: '/tmp', maxBytes: 1_024 });
    expect(cache.unusable).toBeUndefined();
  });

  it('makes read-only mode non-writable and read-write mode writable', () => {
    expect(
      createCacheStore({ mode: 'read-only', projectRoot: '/tmp', maxBytes: 1_024 }).writable,
    ).toBe(false);
    expect(
      createCacheStore({ mode: 'read-write', projectRoot: '/tmp', maxBytes: 1_024 }).writable,
    ).toBe(true);
  });
});
