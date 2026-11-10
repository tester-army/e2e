import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';

/** Converts validated legacy entries without deleting originals or replacing existing code. */
export async function migrateReplayCache(directory: string): Promise<readonly string[]> {
  const json = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
  const code = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true, format: 'code' });
  const results: string[] = [];
  for (const key of (await json.keyHashes()).toSorted()) {
    const existing = await code.read(key);
    if (existing.status !== 'miss') {
      results.push(`${key}: skipped existing code (${existing.status})`);
      continue;
    }
    const read = await json.read(key);
    if (read.status !== 'hit') {
      results.push(`${key}: cannot convert (${read.status === 'invalid' ? read.reason : 'missing'})`);
      continue;
    }
    const written = await code.write(key, read.entry.payload);
    const gaps = read.entry.payload.actions.filter((action) => action.name === 'tool').length;
    results.push(`${key}: ${written === undefined ? 'cannot convert (size limit)' : 'converted'}${gaps > 0 ? `; ${gaps} agent handoff gap(s) preserved` : ''}${read.entry.payload.truncated === true ? '; truncated, remains a miss' : ''}`);
  }
  return results;
}
