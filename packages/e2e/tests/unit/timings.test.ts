import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { loadTimings, writeTimings } from '../../src/run/timings.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project directory holding the given files, with `.e2e/` for the history beside them. */
function project(files: readonly string[]): { root: string; timings: string; report: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-timings-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, '.e2e'));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  return { root, timings: path.join(root, '.e2e', 'timings.json'), report: path.join(root, '.e2e', 'report.json') };
}

/** A report whose result per `[target, file, ms]` row has one attempt of that length. */
function reportOf(rows: readonly (readonly [string, string, number])[]): Report1Document {
  return {
    schemaVersion: 'report-1',
    run: {
      results: rows.map(([targetId, file, ms], index) => ({ id: `r${index}`, status: 'passed', titlePath: ['t'], targetId, file, attempts: [{ durationMs: ms, artifacts: [] }] })),
      serialGroups: [],
      errors: [],
    },
  } as unknown as Report1Document;
}

function history(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('loadTimings', () => {
  it('reads a valid timings file', async () => {
    const { timings, report } = project([]);
    writeFileSync(timings, JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 90 } }));
    expect([...(await loadTimings(timings, report))]).toEqual([['web::a.e2e.ts', 90]]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['another schema version', JSON.stringify({ schemaVersion: 'timings-2', files: { 'web::a.e2e.ts': 90 } })],
    ['no files', JSON.stringify({ schemaVersion: 'timings-1' })],
    ['an array', '[]'],
    ['an extra field', JSON.stringify({ schemaVersion: 'timings-1', files: {}, extra: 1 })],
    ['a key with no target', JSON.stringify({ schemaVersion: 'timings-1', files: { 'a.e2e.ts': 90 } })],
    ['a negative time', JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': -1 } })],
    ['a time that is not an integer', JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 1.5 } })],
    ['a time that is a string', JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': '90' } })],
  ])('is no history for %s', async (_name, content) => {
    const { timings, report } = project([]);
    writeFileSync(timings, content);
    expect((await loadTimings(timings, report)).size).toBe(0);
  });

  it.each([
    ['web::tests/a.e2e.ts', true],
    ['mobile-ios.1::a/b/c.e2e.ts', true],
    ['web::a.e2e.ts::b', true],
    ['web::../outside.e2e.ts', false],
    ['web::tests/../../outside', false],
    ['web::..', false],
    ['web::tests/..', false],
    ['web::/abs/a.e2e.ts', false],
    ['web::C:/a.e2e.ts', false],
    ['web::tests\\a.e2e.ts', false],
    ['web::tests//a.e2e.ts', false],
    ['..::a.e2e.ts', false],
    ['.::a.e2e.ts', false],
    ['::a.e2e.ts', false],
    ['web::', false],
    ['a.e2e.ts', false],
  ])('reads the key %j as the schema does (%s)', async (key, accepted) => {
    const { timings, report } = project([]);
    writeFileSync(timings, JSON.stringify({ schemaVersion: 'timings-1', files: { [key]: 90 } }));
    expect((await loadTimings(timings, report)).size).toBe(accepted ? 1 : 0);
    const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'schema', 'timings-v1.schema.json'), 'utf8')) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({ schemaVersion: 'timings-1', files: { [key]: 90 } })).toBe(accepted);
  });

  it('is no history when nothing is there', async () => {
    const { timings, report } = project([]);
    expect((await loadTimings(timings, report)).size).toBe(0);
  });

  it('falls back to the previous report when the timings file is absent or invalid', async () => {
    const { timings, report } = project([]);
    writeFileSync(report, JSON.stringify(reportOf([['web', 'a.e2e.ts', 120]])));
    expect([...(await loadTimings(timings, report))]).toEqual([['web::a.e2e.ts', 120]]);
    writeFileSync(timings, 'garbage');
    expect([...(await loadTimings(timings, report))]).toEqual([['web::a.e2e.ts', 120]]);
  });
});

describe('writeTimings', () => {
  it('writes a first run as measured, sorted by key', async () => {
    const { root, timings, report } = project(['b.e2e.ts', 'a.e2e.ts']);
    await writeTimings(reportOf([['web', 'b.e2e.ts', 200], ['web', 'a.e2e.ts', 100]]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(history(timings)).toEqual({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 100, 'web::b.e2e.ts': 200 } });
    expect(Object.keys((history(timings) as { files: object }).files)).toEqual(['web::a.e2e.ts', 'web::b.e2e.ts']);
  });

  it('writes a document the timings-1 schema accepts', async () => {
    const { root, timings, report } = project(['a.e2e.ts']);
    await writeTimings(reportOf([['web', 'a.e2e.ts', 100]]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'schema', 'timings-v1.schema.json'), 'utf8')) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(history(timings)), JSON.stringify(validate.errors)).toBe(true);
  });

  it('smooths a measured file toward the new run and keeps one the run did not reach', async () => {
    const { root, timings, report } = project(['a.e2e.ts', 'b.e2e.ts']);
    writeFileSync(timings, JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 300, 'web::b.e2e.ts': 50 } }));
    await writeTimings(reportOf([['web', 'a.e2e.ts', 900]]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(history(timings)).toEqual({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 500, 'web::b.e2e.ts': 50 } });
  });

  it('drops a file that is gone and a target the config no longer has', async () => {
    const { root, timings, report } = project(['a.e2e.ts']);
    writeFileSync(
      timings,
      JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 10, 'web::deleted.e2e.ts': 10, 'old-target::a.e2e.ts': 10 } }),
    );
    await writeTimings(reportOf([['web', 'a.e2e.ts', 10]]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(history(timings)).toEqual({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 10 } });
  });

  it('seeds from the previous report when the file is absent', async () => {
    const { root, timings, report } = project(['a.e2e.ts']);
    writeFileSync(report, JSON.stringify(reportOf([['web', 'a.e2e.ts', 300]])));
    await writeTimings(reportOf([['web', 'a.e2e.ts', 900]]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(history(timings)).toEqual({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 500 } });
  });

  it('leaves the file as it was when the run timed nothing', async () => {
    const { root, timings, report } = project(['a.e2e.ts']);
    const seeded = JSON.stringify({ schemaVersion: 'timings-1', files: { 'web::a.e2e.ts': 70, 'web::deleted.e2e.ts': 9 } });
    writeFileSync(timings, seeded);
    await writeTimings(reportOf([]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(readFileSync(timings, 'utf8')).toBe(seeded);
  });

  it('writes no file when there is no history and the run timed nothing', async () => {
    const { root, timings, report } = project(['a.e2e.ts']);
    await writeTimings(reportOf([]), { timingsPath: timings, reportPath: report, projectRoot: root, targets: new Set(['web']) });
    expect(existsSync(timings)).toBe(false);
  });
});
