/** trace-1 file store: atomic writes, fail-to-miss reads. */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';

const KEY = 'a'.repeat(64);

const payload: ActionTrace = {
  actions: [{ name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } }],
  executor: { name: 'example-agent' },
  summary: 'upgraded the plan',
  startPath: '/settings',
};

/** Temp dirs the cases here create, removed after each so a run leaves nothing behind. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(options: { maxBytes?: number; writable?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-trace-cache-'));
  tempDirs.push(directory);
  return {
    directory,
    store: new FileCacheStore({
      directory,
      maxBytes: options.maxBytes ?? MAX_CACHE_WIRE_BYTES,
      writable: options.writable ?? true,
    }),
  };
}

describe('FileCacheStore', () => {
  it('round-trips one entry under the key digest', async () => {
    const { directory, store } = await makeStore();
    const written = await store.write(KEY, payload);
    expect(written?.bytes).toBeGreaterThan(0);
    expect(await readdir(directory)).toEqual([`${KEY}.json`]);
    const read = await store.read(KEY);
    expect(read.status).toBe('hit');
    expect(read.status === 'hit' && read.entry.payload).toEqual(payload);
  });

  it('misses on an absent entry and rejects a malformed key hash', async () => {
    const { store } = await makeStore();
    expect((await store.read(KEY)).status).toBe('miss');
    expect((await store.read('../escape')).status).toBe('invalid');
    expect(await store.write('../escape', payload)).toBeUndefined();
  });

  it('fails closed on unreadable and oversized entries', async () => {
    const { directory, store } = await makeStore({ maxBytes: 4_096 });
    await writeFile(path.join(directory, `${KEY}.json`), '{ torn', 'utf8');
    expect((await store.read(KEY)).status).toBe('invalid');
    await writeFile(path.join(directory, `${KEY}.json`), `{"pad":"${'x'.repeat(8_192)}"}`, 'utf8');
    expect((await store.read(KEY)).status).toBe('invalid');
  });

  it('refuses to write an entry over its byte cap', async () => {
    const { store } = await makeStore({ maxBytes: 64 });
    expect(await store.write(KEY, payload)).toBeUndefined();
    expect((await store.read(KEY)).status).toBe('miss');
  });

  it('never writes when not writable', async () => {
    const { directory, store } = await makeStore({ writable: false });
    expect(await store.write(KEY, payload)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('evicts an entry on delete, tolerating absence and read-only mode', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload);
    await store.delete(KEY);
    expect(await readdir(directory)).toEqual([]);
    await store.delete(KEY);
    const readOnly = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
    await store.write(KEY, payload);
    await readOnly.delete(KEY);
    expect(await readdir(directory)).toEqual([`${KEY}.json`]);
  });

  it('rejects a delete that leaves the entry in place, so no caller reports it evicted', async () => {
    const { directory, store } = await makeStore();
    await mkdir(path.join(directory, `${KEY}.json`));
    await expect(store.delete(KEY)).rejects.toMatchObject({ code: expect.any(String) });
    expect(await readdir(directory)).toEqual([`${KEY}.json`]);
  });
});
