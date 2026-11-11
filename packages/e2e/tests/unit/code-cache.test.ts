import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitReplayCode, readReplayCode, readTestReplayCode, emitTestReplayCode, cacheFileName } from '../../src/cache/code.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
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
    const files = (await readdir(directory)).filter((name) => name.endsWith('.replay.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const entry = readTestReplayCode(await readFile(path.join(directory, file), 'utf8'));
      expect(entry, file).toBeDefined();
      expect(readTestReplayCode(emitTestReplayCode(entry)), file).toEqual(entry);
    }
  });
});

it('preserves gaps, rejects invalid input, keeps code stable and writes a confirmed repair', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-cache-'));
  const key = 'a'.repeat(64);
  const file = path.join(directory, cacheFileName('fixture'));
  const options = { testId: 'fixture', directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  try {
    const store = new FileCacheStore(options);
    await store.write(key, flow);
    expect(await store.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
    const before = await readFile(file, 'utf8');
    const mtime = (await stat(file)).mtimeMs;
    await store.write(key, flow);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    await store.write(key, { ...flow, summary: 'healed' });
    expect(await readdir(directory)).not.toContain(`${key}.replay.ts.diff`);
    expect(await readFile(file, 'utf8')).not.toBe(before);
    await writeFile(file, 'process.exit(1)');
    expect(await store.read(key)).toMatchObject({ status: 'invalid' });
    const readonly = new FileCacheStore({ ...options, writable: false });
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

it('ignores old JSON files in lookup, strict indexing and deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'code-legacy-'));
  const key = 'a'.repeat(64);
  const file = path.join(directory, `${key}.json`);
  try {
    await writeFile(file, 'not even valid JSON');
    const store = new FileCacheStore({ testId: 'fixture', directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    expect(await store.read(key)).toEqual({ status: 'miss' });
    expect(await store.keyHashes()).toEqual([]);
    const recordings = storedRecordingsFor({ dir: directory, mode: 'read-only', store: undefined, strict: { config: true, flag: false } })!;
    expect(await recordings.underAnotherKey(key, { testId: 'test', targetId: 'web', instructionDigest: key, agent: 'default', callIndex: 0, paramsDigest: key })).toBeUndefined();
    await store.write(key, flow);
    expect(await store.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
    await store.delete(key);
    expect(await readFile(file, 'utf8')).toBe('not even valid JSON');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('validates nested test syntax without evaluating metadata or nested calls', () => {
  const source = emitTestReplayCode(replay.test({ id: 'a'.repeat(64), testId: 'test\u2028name' }, [
    replay.step({ key: 'b'.repeat(64), order: 0, variant: { project: 'p', target: 'web', agent: 'default' } }, flow),
  ]));
  expect(readTestReplayCode(source.replaceAll('\n', '\r\n')).testId).toBe('test\u2028name');
  for (const bad of [
    source.replace('replay.step(', 'replay.tool('),
    source.replace('replay.define(', 'process.exit('),
    source.replace('"order": 0', '"order": -1'),
    source.replace('"order": 0', '"order": 0, "trace": {}'),
    source.replace('"order": 0', '"order": 0, "__proto__": { "polluted": true }'),
    source + '\nprocess.exit(1);',
  ]) expect(() => readTestReplayCode(bad)).toThrow();
  const recording = readTestReplayCode(source);
  expect(() => readTestReplayCode(emitTestReplayCode({ ...recording, steps: [...recording.steps, ...recording.steps] }))).toThrow('duplicate');
  expect(Object.prototype).not.toHaveProperty('polluted');
});
