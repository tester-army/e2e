import { mkdtemp, readFile, readdir, rm, writeFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitReplayCode, readReplayCode } from '../../src/cache/code.ts';
import { readTraceEntry } from '../../src/cache/trace-read.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { migrateReplayCache } from '../../src/cache/migrate.ts';
import { storedRecordingsFor } from '../../src/cache/rekeyed.ts';
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
  for (const bad of [source + 'throw new Error();', source.replace('replay.tap(', 'replay.eval('), source.replace('"Save"', 'process.exit()'), source.replace('"index": 0', '"index": -1')]) {
    expect(() => readReplayCode(bad)).toThrow();
  }
});

describe.each(['web', 'mobile'])('%s committed recordings', (platform) => {
  it('preserves all actions, targets, templates, outcomes and gaps byte-independently', async () => {
    const directory = path.resolve(import.meta.dirname, `../../../../apps/${platform}-benchmark/.e2e/cache`);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const entry = readTraceEntry(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
      expect(entry, file).toBeDefined();
      expect(readReplayCode(emitReplayCode(entry!.payload))?.payload, file).toEqual(entry!.payload);
    }
  });
});

it('migrates, preserves gaps, rejects invalid input, keeps code stable and writes a confirmed repair', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-cache-'));
  const key = 'a'.repeat(64);
  const file = path.join(directory, `${key}.replay.ts`);
  const options = { directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  try {
    await new FileCacheStore(options).write(key, flow);
    await writeFile(path.join(directory, `${'b'.repeat(64)}.json`), '{}');
    const migrated = await migrateReplayCache(directory);
    expect(JSON.stringify(migrated)).toContain('1 agent handoff gap(s) preserved');
    expect(JSON.stringify(migrated)).toContain('failed');
    const store = new FileCacheStore({ ...options, format: 'code' });
    expect(await store.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
    const before = await readFile(file, 'utf8');
    const mtime = (await stat(file)).mtimeMs;
    await store.write(key, flow);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    await store.write(key, { ...flow, summary: 'healed' });
    expect(await readdir(directory)).not.toContain(`${key}.replay.ts.diff`);
    expect(await readFile(file, 'utf8')).not.toBe(before);
    expect(await migrateReplayCache(directory)).toContainEqual(expect.objectContaining({ key, status: 'skipped' }));
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

it('accepts formatter output, comments, CRLF and arbitrary string contents', () => {
  const strings = ['\u2028', '\u2029', '\r\n', '\\', '"', "'", '\u0000', '\ud800', '😀', '/* comment */', ...Array.from({ length: 128 }, (_, i) => String.fromCodePoint(i))];
  for (const value of strings) {
    const payload = { ...flow, actions: [replay.type({ target: { name: `Field ${value}` }, value, summary: 'type arbitrary text' })] };
    const source = emitReplayCode(payload);
    expect(readReplayCode(source).payload).toEqual(payload);
    expect(readReplayCode(source.replaceAll('\n', '\r\n')).payload).toEqual(payload);
  }
  const source = emitReplayCode(flow).replaceAll('"summary":', 'summary:').replace('replay.tap(', '/* action */ replay.tap(');
  expect(readReplayCode(source).payload).toEqual(flow);
});

it('rejects prototype mutation, duplicate keys, spreads, getters and deep expressions', () => {
  const source = emitReplayCode(flow);
  for (const replacement of ['__proto__: {}', 'summary: "a", summary: "b"', '...process.env', 'get summary() { return "x"; }', 'summary: (() => "x")()', 'summary: process.exit()']) {
    expect(() => readReplayCode(source.replace('"summary": "done"', replacement))).toThrow();
  }
  expect(() => readReplayCode('('.repeat(10000))).toThrow('64');
  expect(() => readReplayCode('// comment\u2028' + '('.repeat(10000))).toThrow('64');
  expect(() => readReplayCode(source + '\nprocess.exit()')).toThrow();
  expect(Object.prototype).not.toHaveProperty('polluted');
});

it('strict code lookup recognizes a JSON-only entry even without complete provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-strict-'));
  const key = 'a'.repeat(64);
  try {
    await new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true }).write(key, flow);
    const recordings = storedRecordingsFor({ dir: directory, format: 'code', mode: 'read-only', store: undefined, strict: { config: true, flag: false } })!;
    expect(await recordings.underAnotherKey(key, { testId: 'test', targetId: 'web', instructionDigest: key })).toMatchObject({ fileName: `${key}.json`, otherFormat: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('migration never overwrites concurrent code and deletes JSON only on explicit successful conversion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-migrate-'));
  const key = 'c'.repeat(64);
  try {
    await new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true }).write(key, flow);
    const results = (await Promise.all([migrateReplayCache(directory), migrateReplayCache(directory)])).flat();
    expect(results.filter((item) => item.status === 'converted')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'skipped')).toHaveLength(1);
    expect(await readdir(directory)).toContain(`${key}.json`);
    await unlink(path.join(directory, `${key}.replay.ts`));
    expect(await migrateReplayCache(directory, true)).toContainEqual(expect.objectContaining({ status: 'converted' }));
    expect(await readdir(directory)).toEqual([`${key}.replay.ts`]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
