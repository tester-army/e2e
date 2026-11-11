/**
 * The timings history (`<output>/timings.json`): a run that executes its tests
 * writes it, `--timings` moves it, a seeded file is read and smoothed into the
 * next one, a file a run only ran part of keeps its entry, and a run that stops
 * before its tests writes nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, runExistingWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

const TWO_TESTS = `import { test } from 'e2e';

test('first', async ({ app }) => {
  await app.open();
});

test('second', async ({ app }) => {
  await app.open();
});
`;

const files = { 'tests/a.e2e.ts': TWO_TESTS, 'tests/b.e2e.ts': TWO_TESTS };
const A = 'fake::tests/a.e2e.ts';
const B = 'fake::tests/b.e2e.ts';

function project() {
  return createProject({ ...files, 'e2e.config.ts': workerFakeConfigSource(2) });
}

function seed(file: string, timings: Record<string, number>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 'timings-1', files: timings }));
}

function read(file: string): { schemaVersion: string; files: Record<string, number> } {
  return JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: string; files: Record<string, number> };
}

describe('timings history', () => {
  it('writes how long each file took to <output>/timings.json', async () => {
    const dir = project();
    const outcome = await runExistingWithConfigFile(dir, {});
    expect(outcome.exitCode).toBe(0);
    const history = read(path.join(dir.dir, '.e2e', 'timings.json'));
    expect(history.schemaVersion).toBe('timings-1');
    expect(Object.keys(history.files).toSorted()).toEqual([A, B]);
    dir.cleanup();
  }, 120_000);

  it('reads a seeded file and smooths the run into it, at the path --timings names', async () => {
    const dir = project();
    const custom = path.join(dir.dir, 'ci', 'timings.json');
    seed(custom, { [A]: 60_000, 'gone::tests/a.e2e.ts': 5, 'fake::tests/deleted.e2e.ts': 5 });
    await runExistingWithConfigFile(dir, { runOptions: { timings: 'ci/timings.json' } });
    const history = read(custom);
    // A third of the way from 60 s toward the few hundred ms the run took.
    expect(history.files[A]).toBeGreaterThan(30_000);
    expect(history.files[A]).toBeLessThan(45_000);
    expect(Object.keys(history.files).toSorted()).toEqual([A, B]);
    expect(existsSync(path.join(dir.dir, '.e2e', 'timings.json'))).toBe(false);
    dir.cleanup();
  }, 120_000);

  it('keeps the entry of a file the run only ran part of', async () => {
    const dir = project();
    const file = path.join(dir.dir, '.e2e', 'timings.json');
    seed(file, { [A]: 60_000, [B]: 60_000 });
    const outcome = await runExistingWithConfigFile(dir, { runOptions: { grep: [/first/] } });
    expect(outcome.report.run.summary).toMatchObject({ selected: 2, executed: 2, discovered: 4 });
    expect(read(file).files).toEqual({ [A]: 60_000, [B]: 60_000 });
    dir.cleanup();
  }, 120_000);

  it('writes nothing for a run that stops before its tests', async () => {
    const dir = project();
    const outcome = await runExistingWithConfigFile(dir, { runOptions: { grep: [/matches nothing/] } });
    expect(outcome.exitCode).not.toBe(0);
    expect(existsSync(path.join(dir.dir, '.e2e'))).toBe(false);
    dir.cleanup();
  }, 120_000);
});
