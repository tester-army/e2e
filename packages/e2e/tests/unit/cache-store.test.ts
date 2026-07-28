/** Cache storage and concurrency (spec 10-determinism.md, CACHE-WRITE-001). */

import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileCacheStore,
  MAX_CACHE_WIRE_BYTES,
  buildCacheKey,
  cacheKeyHash,
  createCacheStore,
  disabledCacheStore,
  type CacheKey,
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
  type: 'locate',
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

function key(overrides: { callIndex?: number } = {}): CacheKey {
  return buildCacheKey({
    project: 'b'.repeat(64),
    testId: 'tests/buy.e2e.ts::buys',
    target,
    method: 'tap',
    callIndex: overrides.callIndex ?? 0,
    instruction: 'the buy button',
    input: {},
    screenFingerprint: 'c'.repeat(64),
    policyVersion: 'policy-0.1',
  });
}

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
    const written = await cache.write(key(), payload);
    expect(written?.bytes).toBeGreaterThan(0);

    const hash = cacheKeyHash(key());
    const raw = await readFile(path.join(directory, `${hash}.json`), 'utf8');
    assertValidCacheEntry(JSON.parse(raw));
    // Wire encoding: two-space indentation and a trailing newline.
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "kind": "locate"');

    const result = await cache.read(hash);
    expect(result.status).toBe('hit');
    expect(result.status === 'hit' && result.entry.payload).toEqual(payload);
  });

  it('reports a miss for an absent key', async () => {
    const { store: cache } = await store();
    expect((await cache.read(cacheKeyHash(key()))).status).toBe('miss');
  });

  it('keeps one file per key', async () => {
    const { store: cache, directory } = await store();
    await cache.write(key({ callIndex: 0 }), payload);
    await cache.write(key({ callIndex: 1 }), payload);
    const entries = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(entries).toHaveLength(2);
  });
});

describe('generation', () => {
  it('starts at one and increments per write under the lock', async () => {
    const { store: cache } = await store();
    for (const expected of [1, 2, 3]) {
      await cache.write(key(), payload);
      const result = await cache.read(cacheKeyHash(key()));
      expect(result.status === 'hit' && result.entry.generation).toBe(expected);
    }
  });

  it('increments monotonically under concurrent writers', async () => {
    const { store: cache } = await store();
    await Promise.all(Array.from({ length: 8 }, () => cache.write(key(), payload)));
    const result = await cache.read(cacheKeyHash(key()));
    expect(result.status).toBe('hit');
    expect(result.status === 'hit' && result.entry.generation).toBe(8);
  });

  it('never leaves a torn entry behind', async () => {
    const { store: cache, directory } = await store();
    await Promise.all(Array.from({ length: 12 }, () => cache.write(key(), payload)));
    // Every file present must parse: the temporary-then-rename sequence means a
    // reader can only ever observe a complete entry.
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(path.join(directory, name), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('leaves no lock or temporary file behind', async () => {
    const { store: cache, directory } = await store();
    await Promise.all(Array.from({ length: 4 }, () => cache.write(key(), payload)));
    const leftovers = (await readdir(directory)).filter((name) => !name.endsWith('.json'));
    expect(leftovers).toEqual([]);
  });
});

describe('reads fail closed', () => {
  async function poison(content: string) {
    const { store: cache, directory } = await store();
    const hash = cacheKeyHash(key());
    await writeFile(path.join(directory, `${hash}.json`), content);
    return { result: await cache.read(hash), cache, directory, hash };
  }

  it('ignores malformed JSON', async () => {
    const { result } = await poison('{not json');
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain('not valid JSON');
  });

  it('ignores an entry whose keyHash does not match its key', async () => {
    const { store: cache, directory } = await store();
    const hash = cacheKeyHash(key());
    const tampered = {
      schemaVersion: 'cache-1',
      kind: 'locate',
      key: key(),
      keyHash: 'f'.repeat(64),
      generation: 1,
      createdAt: '2026-07-24T12:00:00.000Z',
      payload,
    };
    await writeFile(path.join(directory, `${hash}.json`), JSON.stringify(tampered));
    const result = await cache.read(hash);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain('does not match');
  });

  it('ignores a valid entry stored under a foreign key', async () => {
    const { store: cache, directory } = await store();
    // A correctly signed entry moved to another key's file name must not be
    // able to answer for that key.
    const foreign = cacheKeyHash(key({ callIndex: 9 }));
    const entry = {
      schemaVersion: 'cache-1',
      kind: 'locate',
      key: key(),
      keyHash: cacheKeyHash(key()),
      generation: 1,
      createdAt: '2026-07-24T12:00:00.000Z',
      payload,
    };
    await writeFile(path.join(directory, `${foreign}.json`), JSON.stringify(entry));
    const result = await cache.read(foreign);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain('foreign key');
  });

  it('ignores an oversized entry without reading it', async () => {
    const { store: cache, directory } = await store({ maxBytes: 2_048 });
    const hash = cacheKeyHash(key());
    await writeFile(path.join(directory, `${hash}.json`), 'x'.repeat(4_096));
    const result = await cache.read(hash);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain('over the');
  });

  it('caps the configured limit at the wire ceiling', async () => {
    const { store: cache, directory } = await store({ maxBytes: MAX_CACHE_WIRE_BYTES * 4 });
    const hash = cacheKeyHash(key());
    await writeFile(path.join(directory, `${hash}.json`), 'x'.repeat(MAX_CACHE_WIRE_BYTES + 1));
    expect((await cache.read(hash)).status).toBe('invalid');
  });

  it('refuses a key hash that is not a bare digest', async () => {
    const { store: cache } = await store();
    for (const hash of ['../escape', 'a/b', 'A'.repeat(64), 'short', `${'a'.repeat(64)}/x`]) {
      const result = await cache.read(hash);
      expect(result.status).toBe('invalid');
      expect(result.status === 'invalid' && result.reason).toContain('SHA-256');
    }
  });

  it('ignores a directory in place of an entry', async () => {
    const { store: cache, directory } = await store();
    const hash = cacheKeyHash(key());
    await mkdir(path.join(directory, `${hash}.json`));
    expect((await cache.read(hash)).status).toBe('invalid');
  });

  it('replaces a poisoned entry on the next write', async () => {
    const { cache, hash } = await poison('{not json');
    await cache.write(key(), payload);
    const result = await cache.read(hash);
    expect(result.status).toBe('hit');
    expect(result.status === 'hit' && result.entry.generation).toBe(1);
  });
});

describe('write modes', () => {
  it('never writes when not writable', async () => {
    const { store: cache, directory } = await store({ writable: false });
    expect(cache.writable).toBe(false);
    expect(await cache.write(key(), payload)).toBeUndefined();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it('refuses to write an entry over the size limit', async () => {
    const { store: cache, directory } = await store({ maxBytes: 1_024 });
    const large: LocatePayload = {
      ...payload,
      expected: { role: 'button', name: 'x'.repeat(4_096) },
    };
    expect(await cache.write(key(), large)).toBeUndefined();
    const entries = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(entries).toEqual([]);
  });

  it('sweeps abandoned temporary files', async () => {
    const { store: cache, directory } = await store();
    const stale = path.join(directory, `${cacheKeyHash(key())}.json.999.abandoned.tmp`);
    await writeFile(stale, 'partial');
    // Backdate the file past the abandonment threshold.
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 600_000);
    await utimes(stale, old, old);

    await cache.write(key(), payload);
    expect(await readdir(directory)).not.toContain(path.basename(stale));
  });
});

describe('store selection', () => {
  it('disables the cache entirely for mode off', async () => {
    const cache = createCacheStore({ mode: 'off', projectRoot: '/tmp', maxBytes: 1_024 });
    expect(cache).toBe(disabledCacheStore);
    expect((await cache.read(cacheKeyHash(key()))).status).toBe('miss');
    expect(await cache.write(key(), payload)).toBeUndefined();
  });

  it('makes read-only mode non-writable and read-write mode writable', () => {
    const readOnly = createCacheStore({
      mode: 'read-only',
      projectRoot: '/tmp',
      maxBytes: 1_024,
    });
    const readWrite = createCacheStore({
      mode: 'read-write',
      projectRoot: '/tmp',
      maxBytes: 1_024,
    });
    expect(readOnly.writable).toBe(false);
    expect(readWrite.writable).toBe(true);
  });
});
