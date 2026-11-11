import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readReplayYaml } from '../../src/cache/yaml.ts';
import { cacheFileName } from '../../src/cache/file-name.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { pruneTestRecordings } from '../../src/cache/cleanup.ts';
import { sha256Hex } from '../../src/internal/ids.ts';
import { projectIdentity } from '../../src/cache/identity.ts';
import type { ActionTrace } from '../../src/cache/trace.ts';

const testId = 'tests/flow.e2e.ts::flow';
const first = 'a'.repeat(64), second = 'b'.repeat(64), third = 'c'.repeat(64);
const trace: ActionTrace = { executor: { name: 'fixture' }, actions: [{ name: 'tap', summary: 'Save', target: { name: 'Save', role: 'button' } }], summary: 'Saved' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** Isolates transactions while allowing several stores to share a test's file. */
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-test-recording-'));
  dirs.push(directory);
  const file = path.join(directory, cacheFileName(testId));
  const store = (target = 'web', options: { writable?: boolean; maxBytes?: number } = {}) => new FileCacheStore({
    directory, testId, variant: { project: projectIdentity('fixture'), target, agent: 'default' },
    deferred: true, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true, ...options,
  });
  return { directory, file, store, read: async () => readReplayYaml(await readFile(file, 'utf8')) };
}

describe('test recording transactions', () => {
  it('writes calls in encounter order, preserves other targets under concurrent commits, and avoids rewrites', async () => {
    const f = await fixture();
    const web = f.store(), ios = f.store('ios');
    web.claim(second); web.claim(first); ios.claim(first);
    await web.write(first, trace); await web.write(second, trace); await ios.write(first, trace);
    await Promise.all([web.flush(true), ios.flush(true)]);
    expect(await readdir(f.directory)).toEqual([cacheFileName(testId)]);
    const steps = (await f.read()).steps;
    expect(steps.filter((step) => step.variant.target === sha256Hex('web')).map((step) => step.key)).toEqual([second, first]);
    expect(steps.filter((step) => step.variant.target === sha256Hex('ios'))).toHaveLength(1);
    const before = await stat(f.file);
    await web.flush(true);
    expect((await stat(f.file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('only a completed attempt prunes unvisited calls and only its own variant', async () => {
    const f = await fixture();
    const initial = f.store(), ios = f.store('ios');
    for (const key of [first, second]) { initial.claim(key); await initial.write(key, trace); }
    ios.claim(third); await ios.write(third, trace);
    await initial.flush(true); await ios.flush(true);
    const partial = f.store();
    partial.claim(first); await partial.write(first, { ...trace, summary: 'Updated' });
    await partial.flush(false);
    expect((await f.read()).steps).toHaveLength(3);
    await partial.flush(true);
    expect((await f.read()).steps.map((step) => step.key)).toEqual([third, first]);
    await f.store().flush(true);
    expect((await f.read()).steps.map((step) => step.key)).toEqual([third]);
  });

  it('preserves the previous file if the merged container exceeds the byte cap', async () => {
    const f = await fixture();
    const store = f.store(); store.claim(first); await store.write(first, trace); await store.flush(true);
    const before = await readFile(f.file, 'utf8');
    const capped = f.store('ios', { maxBytes: Buffer.byteLength(before) + 20 });
    capped.claim(second);
    expect(await capped.write(second, trace)).toBeDefined();
    await expect(capped.flush(true)).rejects.toThrow('byte limit');
    expect(await readFile(f.file, 'utf8')).toBe(before);
  });

  it('strict/read-only stores never prune or write', async () => {
    const f = await fixture();
    const store = f.store(); await store.write(first, trace); await store.flush(false);
    const before = await readFile(f.file, 'utf8');
    const readonly = f.store('web', { writable: false });
    expect(await readonly.write(second, trace)).toBeUndefined();
    await readonly.delete(first); await readonly.flush(true);
    expect(await readFile(f.file, 'utf8')).toBe(before);
  });

  it('ignores old JSON and rejects identity mismatches rather than replaying another test', async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, `${first}.json`), 'old JSON must never be parsed');
    expect(await f.store().read(first)).toEqual({ status: 'miss' });
    const store = f.store(); await store.write(first, trace); await store.flush(false);
    const source = await readFile(f.file, 'utf8');
    await writeFile(f.file, source.replace((await f.read()).id, 'd'.repeat(64)));
    expect(await store.read(first)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('identity') });
  });

  it('prunes renamed or deleted tests only when collection establishes absence', async () => {
    const f = await fixture();
    const store = f.store(); await store.write(first, trace); await store.flush(false);
    const options = { directory: f.directory, projectRoot: f.directory, projectId: 'fixture', testIds: new Set<string>(), collectedFiles: new Set<string>(), fullCollection: false };
    await pruneTestRecordings(options);
    expect((await f.read()).steps).toHaveLength(1);
    await pruneTestRecordings({ ...options, collectedFiles: new Set(['tests/flow.e2e.ts']) });
    expect(await readdir(f.directory)).toEqual([]);
    await store.write(first, trace); await store.flush(false);
    await pruneTestRecordings({ ...options, fullCollection: true });
    expect(await readdir(f.directory)).toEqual([]);
  });
});

it('does not serialize raw target or agent identity values', async () => {
  const f = await fixture();
  const secret = 'private-target-and-agent';
  const store = new FileCacheStore({ directory: f.directory, testId, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true, variant: { project: projectIdentity('fixture'), target: secret, agent: secret } });
  expect(await store.write(first, trace)).toBeDefined();
  expect(await readFile(f.file, 'utf8')).not.toContain(secret);
  expect(await store.read(first)).toMatchObject({ status: 'hit' });
  expect((await f.read()).steps[0]!.variant).toEqual({ project: projectIdentity('fixture'), target: sha256Hex(secret), agent: sha256Hex(secret) });
});

it('round-trips source-like recorded text without truncating the declaration', async () => {
  const f = await fixture();
  const store = f.store();
  const payload: ActionTrace = { ...trace, summary: 'export default 42;', actions: [{ name: 'type', target: { name: 'export default input' }, summary: 'export default type', value: 'export default 42;\u2028\u2029' }] };
  expect(await store.write(first, payload)).toBeDefined();
  await store.flush(false);
  expect(await store.read(first)).toMatchObject({ status: 'hit', entry: { payload } });
});

it('finds provider-redacted filenames before the next run resolves the provider and keeps one file across variants', async () => {
  const f = await fixture();
  const original = 'tests/login.e2e.ts::signs-in-with-private-value';
  const redacted = original.replace('private-value', '[secret:password]');
  const payload: ActionTrace = { ...trace, recordedFor: { testId: redacted, targetId: 'web', instructionDigest: first } };
  const options = { directory: f.directory, testId: original, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true };
  const writer = new FileCacheStore({ ...options, variant: { project: 'p', target: 'web', agent: 'default' } });
  expect(await writer.write(first, payload)).toBeDefined();
  expect(await readdir(f.directory)).toEqual([cacheFileName(redacted)]);
  const next = new FileCacheStore({ ...options, variant: { project: 'p', target: 'mobile', agent: 'default' } });
  expect((await next.recording())?.recording.id).toBe(sha256Hex(original));
  expect(await next.write(second, { ...payload, recordedFor: { ...payload.recordedFor!, testId: original } })).toBeDefined();
  expect(await readdir(f.directory)).toEqual([cacheFileName(redacted)]);
  const recording = (await next.recording())!.recording;
  expect(recording.steps).toHaveLength(2);
  expect(JSON.stringify(recording)).not.toContain('private-value');
});

it('preserves Unicode provenance capped in the middle of a percent escape', async () => {
  const f = await fixture();
  const original = 'tests/save.e2e.ts::' + encodeURIComponent('save ' + '😀'.repeat(40));
  const capped = original.slice(0, 299) + '…';
  const payload: ActionTrace = { ...trace, recordedFor: { testId: capped, targetId: 'web', instructionDigest: first } };
  const store = new FileCacheStore({ directory: f.directory, testId: original, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
  expect(await store.write(first, payload)).toBeDefined();
  expect(await store.read(first)).toMatchObject({ status: 'hit', entry: { payload } });
});
