import { link, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';
import { CACHE_CODECS, cacheFileName } from './codec.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { errorMessage } from '../internal/errors.ts';

export interface MigrationOutcome {
  readonly key: string;
  readonly status: 'converted' | 'skipped' | 'failed';
  readonly test?: string;
  readonly detail: string;
}

/** Converts validated entries without overwriting code, even when another writer publishes first. */
export async function migrateReplayCache(directory: string, deleteJson = false): Promise<readonly MigrationOutcome[]> {
  const json = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
  const results: MigrationOutcome[] = [];
  for (const key of (await json.keyHashes()).toSorted()) {
    const temporary = join(directory, `${key}.${randomBytes(8).toString('hex')}.migration.tmp`);
    try {
      const read = await json.read(key);
      if (read.status !== 'hit') {
        results.push({ key, status: 'failed', detail: read.status === 'invalid' ? read.reason : 'source disappeared' });
        continue;
      }
      const sourcePath = join(directory, cacheFileName(key, 'json'));
      const source = await readFile(sourcePath, 'utf8');
      const current = CACHE_CODECS.json.decode(source);
      if (current === undefined || JSON.stringify(current.payload) !== JSON.stringify(read.entry.payload)) throw new Error('source changed during migration; retry when no run is writing');
      const code = CACHE_CODECS.code.encode(read.entry.payload);
      if (Buffer.byteLength(code) > MAX_CACHE_WIRE_BYTES) throw new Error('converted entry exceeds size limit');
      await writeFileAtomic(temporary, code, { mode: 0o600 });
      try {
        await link(temporary, join(directory, cacheFileName(key, 'code')));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        results.push({ key, status: 'skipped', detail: 'existing code left untouched; inspect it before removing JSON' });
        continue;
      }
      if (deleteJson) {
        if (await readFile(sourcePath, 'utf8') !== source) throw new Error('source changed; code created but JSON retained');
        await unlink(sourcePath);
      }
      const gaps = read.entry.payload.actions.filter((action) => action.name === 'tool').length;
      results.push({ key, status: 'converted', ...(read.entry.payload.recordedFor === undefined ? {} : { test: read.entry.payload.recordedFor.testId }), detail: `${gaps} agent handoff gap(s) preserved${read.entry.payload.truncated === true ? '; truncated, remains a miss' : ''}; JSON ${deleteJson ? 'removed' : 'retained'}` });
    } catch (cause) {
      results.push({ key, status: 'failed', detail: errorMessage(cause) });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return results;
}
