import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { emitReplayYaml, encodeReplayYaml, readReplayYaml } from '../../src/cache/yaml.ts';
import { cacheFileName, resolveCacheFile } from '../../src/cache/file-name.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';
import type { ReplayTest } from '../../src/cache/test-file.ts';
import { sha256Hex } from '../../src/internal/ids.ts';

const flow: ActionTrace = {
  instruction: 'save the profile',
  executor: { name: 'test' }, summary: 'done', startPath: '/form', endPath: '/done', endAnchors: [{ role: 'status', name: 'Saved' }],
  actions: [
    { name: 'tap', target: { role: 'button', name: 'Save', within: 'Profile', position: { index: 0, of: 1 } }, summary: 'save' },
    { name: 'tool', derived: 'whole-node', summary: 'read runtime code' },
  ],
};
function recording(trace = flow): ReplayTest {
  return { id: sha256Hex('tests/save.e2e.ts::saves'), testId: 'tests/save.e2e.ts::saves', steps: [{ key: 'b'.repeat(64), order: 0, variant: { project: 'p', target: 'web', agent: 'default' }, trace }] };
}

it('emits readable actions and stable metadata, with no timestamp or executable API', () => {
  const source = encodeReplayYaml(recording());
  expect(readReplayYaml(source)).toEqual(recording());
  expect(source).toContain('- tap: {');
  expect(source).toContain('- wait: { role: status, name: Saved }');
  expect(source).toContain('instruction: save the profile');
  expect(source).not.toMatch(/createdAt|import |replay\./u);
  expect(encodeReplayYaml(recording({ ...flow, executor: { ...flow.executor } }))).toBe(source);
  expect(encodeReplayYaml(readReplayYaml(source))).toBe(source);
});

describe.each(['web', 'mobile'])('%s committed recordings', (platform) => {
  it('round-trips every target, action, template, outcome and handoff gap', async () => {
    const directory = path.resolve(import.meta.dirname, `../../../../apps/${platform}-benchmark/.e2e/cache`);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(path.join(directory, file), 'utf8');
      const entry = readReplayYaml(source, file);
      expect(readReplayYaml(encodeReplayYaml(entry)), file).toEqual(entry);
      expect(encodeReplayYaml(entry), file).toBe(source);
      expect(entry.steps.every((step) => step.trace.instruction !== undefined)).toBe(true);
    }
  });
});

it('round-trips arbitrary strings and quotes YAML 1.1 and core ambiguous scalars', () => {
  const strings = ['yes', 'no', 'on', 'off', 'null', 'true', '2001-01-01', '0123', '1e3', '\u2028', '\u2029', '\r\n', '\\', '"', "'", '\ud800', '😀', ...Array.from({ length: 128 }, (_, i) => String.fromCodePoint(i))];
  for (const value of strings) {
    const entry = recording({ ...flow, actions: [{ name: 'type', target: { name: `Field ${value}`, value: 'old' }, value, summary: 'type' }] });
    const source = encodeReplayYaml(entry);
    expect(readReplayYaml(source), JSON.stringify(value)).toEqual(entry);
    expect(readReplayYaml(source.replaceAll('\n', '\r\n'))).toEqual(entry);
  }
  for (const value of strings.slice(0, 9)) expect(emitReplayYaml(recording({ ...flow, instruction: value }))).toContain(`instruction: "${value}"`);
});

it('rejects unsafe YAML and reports the file and source line', () => {
  const source = encodeReplayYaml(recording());
  for (const replacement of ['&anchor saves', '*anchor', '!!str saves', '!custom saves', '{ __proto__: {} }', '{ constructor: {} }', '{ <<: {} }']) {
    expect(() => readReplayYaml(source.replace('test: saves', `test: ${replacement}`), 'save.yml')).toThrow(/save.yml:1:/u);
  }
  for (const bad of [
    source + '\nidentity: {}',
    source.replace('checks:', 'checks:\n        actions: invalid'),
    source.replace('checks:', 'checks:\n        instruction: 123'),
    source.replace('order: 0', 'order: -1'),
    source.replace('order: 0', 'order: .inf'),
    source.replace('order: 0', 'order: 0\n      surprise: true'),
    source.replace('- tap:', '- runShell:'),
    source.replace('position: { index: 0, of: 1 }', 'position: { index: -1, of: 1 }'),
    source.replace('recordedWith: {}', 'recordedWith: { platform: android }'),
    source.replace('instruction: save the profile', 'instruction: save the profile\n    params: wrong'),
  ]) expect(() => readReplayYaml(bad, 'save.yml')).toThrow(/save.yml:\d+:/u);
  expect(() => readReplayYaml('x'.repeat(MAX_CACHE_WIRE_BYTES + 1), 'huge.yml')).toThrow('huge.yml:');
  expect(() => readReplayYaml('x: ' + '['.repeat(100) + '0' + ']'.repeat(100), 'deep.yml')).toThrow('64 nesting');
  expect(Object.prototype).not.toHaveProperty('polluted');
});

it('rejects duplicate act identities and unknown action fields', () => {
  const entry = recording();
  expect(() => readReplayYaml(emitReplayYaml({ ...entry, steps: [...entry.steps, ...entry.steps] }))).toThrow('duplicate');
  const source = emitReplayYaml(entry);
  expect(() => readReplayYaml(source.replace('- tap: {', '- tap: { surprise: 1,'))).toThrow();
});

it('makes safe readable names, with deterministic suffixes only on collisions', async () => {
  expect(cacheFileName('tests/login.e2e.ts::logs%20in')).toBe('login-logs-in.yml');
  expect(cacheFileName('../CON.ts')).toBe('test-con.yml');
  expect(cacheFileName('x.ts::../../evil/\\file')).not.toMatch(/[\\/]/u);
  expect(cacheFileName('x.ts::' + 'long'.repeat(100)).length).toBeLessThanOrEqual(76);
  const ids = ['tests/save.e2e.ts::Save!', 'tests/save.e2e.ts::Save?'];
  expect(cacheFileName(ids[0]!)).toBe(cacheFileName(ids[1]!));
  const outputs: string[][] = [];
  for (const order of [ids, ids.toReversed()]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yaml-collision-'));
    try {
      const stores = order.map((testId) => new FileCacheStore({ testId, directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true }));
      await Promise.all(stores.map((store) => store.write('b'.repeat(64), flow)));
      const names = (await readdir(directory)).toSorted();
      outputs.push(names);
      expect(names).toHaveLength(2);
      expect(names.every((name) => /^save--[a-f0-9]{12}\.yml$/u.test(name))).toBe(true);
      for (const [index, store] of stores.entries()) {
        expect(await store.read('b'.repeat(64))).toMatchObject({ status: 'hit' });
        const file = await resolveCacheFile(directory, order[index]!);
        expect(readReplayYaml(await readFile(file, 'utf8')).id).toBe(sha256Hex(order[index]!));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it('ignores old formats, preserves read-only files, and atomically repairs invalid YAML', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yaml-store-'));
  const key = 'b'.repeat(64), testId = 'fixture';
  const file = path.join(directory, cacheFileName(testId));
  const options = { testId, directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  try {
    for (const extension of ['json', 'replay.ts']) await writeFile(path.join(directory, `${key}.${extension}`), 'old data must never be read');
    const store = new FileCacheStore(options);
    expect(await store.read(key)).toEqual({ status: 'miss' });
    expect(await store.write(key, flow)).toBeDefined();
    expect(await store.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
    const before = await readFile(file, 'utf8'), mtime = (await stat(file)).mtimeMs;
    await store.write(key, flow);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    await writeFile(file, 'test: *forbidden');
    expect(await store.read(key)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('fixture.yml:') });
    const readonly = new FileCacheStore({ ...options, writable: false });
    expect(await readonly.write(key, flow)).toBeUndefined();
    await readonly.delete(key);
    expect(await readFile(file, 'utf8')).toBe('test: *forbidden');
    await store.write(key, flow);
    expect(await readFile(file, 'utf8')).toBe(before);
    await store.delete(key);
    expect(await store.read(key)).toEqual({ status: 'miss' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('re-resolves a file renamed by a colliding writer between lookup and opening', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yaml-rename-race-'));
  const options = { directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  const first = new FileCacheStore({ ...options, testId: 'save.ts::Save!' });
  const other = new FileCacheStore({ ...options, testId: 'save.ts::Save?' });
  const key = 'b'.repeat(64);
  try {
    expect(await first.write(key, flow)).toBeDefined();
    const base = path.join(directory, cacheFileName('save.ts::Save!'));
    const original = fs.stat;
    let reads = 0;
    const hook = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === base && ++reads === 2) expect(await other.write(key, flow)).toBeDefined();
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await first.read(key)).toMatchObject({ status: 'hit', entry: { payload: flow } });
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally { hook.mockRestore(); syncBuiltinESMExports(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
