import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitReplayCode, readReplayCode } from '../../src/cache/code.ts';
import { readTraceEntry } from '../../src/cache/trace-read.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { migrateReplayCache } from '../../src/cache/migrate.ts';
import { replay } from '../../src/replay.ts';

const flow = replay.define({ executor: { name: 'test' }, summary: 'done', startPath: '/form', endPath: '/done', endAnchors: [{ role: 'status', name: 'Saved' }] }, [
  replay.tap({ target: { role: 'button', name: 'Save', within: 'Profile', position: { index: 0, of: 1 } }, summary: 'save' }),
  replay.tool({ derived: 'whole-node', summary: 'read runtime code' }),
]);

it('round-trips typed operations and never includes a recording timestamp', () => {
  const source = emitReplayCode(flow);
  expect(readReplayCode(source)?.payload).toEqual(flow);
  expect(source).toContain('replay.tap(');
  expect(source).not.toContain('createdAt');
  expect(emitReplayCode({ ...flow, executor: { ...flow.executor } })).toBe(source);
});

it('refuses executable expressions, unknown calls, malformed payloads and appended code', () => {
  const source = emitReplayCode(flow);
  for (const bad of [source + 'throw new Error();', source.replace('replay.tap(', 'replay.eval('), source.replace('"Save"', 'process.exit()'), source.replace('"index":0', '"index":-1')]) {
    expect(readReplayCode(bad)).toBeUndefined();
  }
});

describe.each(['web', 'mobile'])('%s committed recordings', (platform) => {
  it('preserves all actions, targets, templates, outcomes and gaps byte-independently', async () => {
    const directory = path.resolve(`../../apps/${platform}-benchmark/.e2e/cache`);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const entry = readTraceEntry(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
      expect(entry, file).toBeDefined();
      expect(readReplayCode(emitReplayCode(entry!.payload))?.payload, file).toEqual(entry!.payload);
    }
  });
});

it('migrates, preserves gaps, rejects invalid input, keeps code stable and records a healing diff', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-cache-'));
  const key = 'a'.repeat(64);
  const file = path.join(directory, `${key}.replay.ts`);
  const options = { directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  try {
    await new FileCacheStore(options).write(key, flow);
    await writeFile(path.join(directory, `${'b'.repeat(64)}.json`), '{}');
    const migrated = await migrateReplayCache(directory);
    expect(migrated.join('\n')).toContain('1 agent handoff gap(s) preserved');
    expect(migrated.join('\n')).toContain('cannot convert');
    const store = new FileCacheStore({ ...options, format: 'code' });
    expect(await store.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
    const before = await readFile(file, 'utf8');
    const mtime = (await stat(file)).mtimeMs;
    await store.write(key, flow);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    await store.write(key, { ...flow, summary: 'healed' });
    expect(await readFile(`${file}.diff`, 'utf8')).toContain('+    "summary": "healed",');
    expect(await readFile(file, 'utf8')).not.toBe(before);
    expect((await migrateReplayCache(directory)).join('\n')).toContain('skipped existing code');
    await writeFile(file, 'process.exit(1)');
    expect(await store.read(key)).toMatchObject({ status: 'invalid' });
    const readonly = new FileCacheStore({ ...options, writable: false, format: 'code' });
    expect(await readonly.write(key, flow)).toBeUndefined();
    await readonly.delete(key);
    expect(await readFile(file, 'utf8')).toBe('process.exit(1)');
    await store.delete(key);
    expect(await store.read(key)).toMatchObject({ status: 'miss' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
