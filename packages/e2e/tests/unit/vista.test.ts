import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, expect, it } from 'vitest';
import { vista } from '../../src/cli/vista.ts';
import { decodePng, encodePng } from '../../src/internal/image.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A saved run with one tiny checkpoint; tests vary identity, attempts, and files independently. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-vista-'));
  roots.push(root);
  const checkpoint = { api: 'app.vista', label: '<script>alert("x")</script>', status: 'passed', artifacts: ['image'] };
  const artifact = { id: 'image', kind: 'screenshot', path: 'shot.png', redaction: 'complete' };
  const attempt = { index: 0, status: 'passed', steps: [checkpoint], artifacts: [artifact] };
  const entry = { testId: 'old-id', file: 'tests/cart.e2e.ts', titlePath: ['cart'], targetId: 'web', platform: 'web',
    agent: 'default', repeat: 0, selected: true, attempts: [attempt] };
  const document = { schemaVersion: 'report-1', run: { id: 'run', results: [entry], serialGroups: [] as unknown[] } };
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  /** Persists an independent report and image. */
  const save = async (directory: string, report: unknown = document, color = 0, width = 2) => {
    await mkdir(path.join(directory, 'results'), { recursive: true });
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
    await writeFile(path.join(directory, 'results/shot.png'), encodePng({ width, height: 2, data: new Uint8Array(width * 8).fill(color) }));
  };
  await save(before);
  await save(after);
  const output = path.join(root, 'comparison');
  return { root, before, after, output, document, entry, attempt, checkpoint, artifact, save };
}

/** Reads and schema-checks the actual generated agent index. */
async function index(output: string) {
  const data = JSON.parse(await readFile(path.join(output, 'index.json'), 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../../schema/vista-v1.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
  return data;
}

it('pairs by semantic name across changed test ids, preserves dimensions, and escapes hostile labels', async () => {
  const f = await fixture();
  f.entry.testId = 'new-id';
  await f.save(f.after, f.document, 255, 3);
  expect(await vista(f.before, f.after, f)).toMatchObject({ count: 1, unavailable: 0 });
  const data = await index(f.output);
  expect(data.pairs[0].status).toBe('changed');
  const combined = decodePng(await readFile(path.join(f.output, data.pairs[0].paired)));
  expect([combined.width, combined.height]).toEqual([29, 2]);
  expect(combined.data.slice(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 0));
  expect(combined.data.slice(26 * 4, 27 * 4)).toEqual(Uint8Array.of(255, 255, 255, 255));
  const html = await readFile(path.join(f.output, 'index.html'), 'utf8');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  await rm(f.before, { recursive: true });
  await rm(f.after, { recursive: true });
  expect(decodePng(await readFile(path.join(f.output, data.pairs[0].before.image))).width).toBe(2);
  await expect(vista(f.output, f.output, f)).rejects.toThrow();
});

it('keeps targets, repeats, repeated names and agent variants separate, with explicit target mapping', async () => {
  const f = await fixture();
  f.attempt.steps.push({ ...f.checkpoint });
  f.document.run.results.push({ ...f.entry, repeat: 1 }, { ...f.entry, agent: 'other' }, { ...f.entry, targetId: 'mobile' });
  await f.save(f.before);
  await f.save(f.after);
  expect(await vista(f.before, f.after, f)).toMatchObject({ count: 8, unavailable: 0 });
  expect((await index(f.output)).pairs.every((pair: { status: string }) => pair.status === 'identical')).toBe(true);
  await expect(vista(f.before, f.after, f)).rejects.toThrow('EEXIST');
  await expect(vista(f.before, f.after, { ...f, beforeTarget: 'web' })).rejects.toThrow('together');
  await expect(vista(f.before, f.after, { ...f, beforeTarget: 'absent', afterTarget: 'web' })).rejects.toThrow('absent');
  const mapped = path.join(f.root, 'mapped');
  expect(await vista(f.before, f.after, { output: mapped, beforeTarget: 'web', afterTarget: 'mobile' })).toMatchObject({ count: 6, unavailable: 4 });
});

it('uses the final retry, including serial members, and shows missing checkpoints and failed captures', async () => {
  const f = await fixture();
  f.entry.attempts.push({ ...f.attempt, index: 1, steps: [{ ...f.checkpoint, label: 'last retry' }] });
  await f.save(f.before);
  const serialEntry = { ...f.entry, attempts: [], serialGroupId: 'group' };
  f.document.run.results = [serialEntry];
  f.document.run.serialGroups = [{ id: 'group', attempts: [{ index: 2, status: 'failed', artifacts: [f.artifact],
    members: [{ testId: 'old-id', status: 'failed', steps: [{ ...f.checkpoint, label: 'last retry', status: 'failed' }, { ...f.checkpoint, label: 'extra' }] }] }] }];
  await f.save(f.after);
  expect(await vista(f.before, f.after, f)).toMatchObject({ count: 2, unavailable: 2 });
  const data = await index(f.output);
  const pair = data.pairs.find((item: { identity: { name: string } }) => item.identity.name === 'last retry');
  expect(pair.before.attempt).toBe(1);
  expect(pair.after.attempt).toBe(2);
  expect(pair.after.unavailable).toContain('failed');
  expect(pair.paired).toBeUndefined();
});

it.each(['missing', 'traversal', 'symlink', 'unredacted', 'corrupt'])('reports %s evidence as unavailable', async (mode) => {
  const f = await fixture();
  if (mode === 'unredacted') f.artifact.redaction = 'incomplete';
  if (mode === 'traversal') f.artifact.path = '../../outside.png';
  await f.save(f.after);
  const image = path.join(f.after, 'results/shot.png');
  if (mode === 'missing' || mode === 'symlink') await rm(image);
  if (mode === 'corrupt') await writeFile(image, 'not png');
  if (mode === 'symlink') await symlink(path.join(f.before, 'results/shot.png'), image);
  expect(await vista(f.before, f.after, f)).toMatchObject({ unavailable: 1 });
  expect((await index(f.output)).pairs[0].after.unavailable).toBeTruthy();
});

it('rejects ambiguous identities, empty selections, and malformed reports', async () => {
  const f = await fixture();
  f.document.run.results.push(f.entry);
  await f.save(f.after);
  await expect(vista(f.before, f.after, f)).rejects.toThrow('ambiguous');
  f.document.run.results = [];
  await f.save(f.before);
  await f.save(f.after);
  await expect(vista(f.before, f.after, f)).rejects.toThrow('no app.vista');
  await f.save(f.before, { schemaVersion: 'other' });
  await expect(vista(f.before, f.after, f)).rejects.toThrow('not a supported report-1');
});


it('includes preserved rerun evidence and marks its earlier-run provenance', async () => {
  const f = await fixture();
  await f.save(f.after, { ...f.document, run: { ...f.document.run, results: [],
    carried: { results: [f.entry], serialGroups: [] } } });
  expect(await vista(f.before, f.after, f)).toMatchObject({ count: 1, unavailable: 0 });
  const pair = (await index(f.output)).pairs[0];
  expect(pair.before.carried).toBe(false);
  expect(pair.after.carried).toBe(true);
  expect(await readFile(path.join(f.output, 'index.html'), 'utf8')).toContain('carried from an earlier run');
});


it('rejects unavailable pairs with two available images or neither side recorded', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schema/vista-v1.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const document = JSON.parse(await readFile(new URL('../../schema/fixtures/vista-v1.valid.json', import.meta.url), 'utf8'));
  const pair = document.pairs[0];
  pair.status = 'unavailable';
  delete pair.paired;
  expect(validate(document)).toBe(false);
  delete pair.before;
  expect(validate(document)).toBe(true);
  delete pair.after;
  expect(validate(document)).toBe(false);
});
