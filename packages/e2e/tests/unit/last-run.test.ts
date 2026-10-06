import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resultId } from '../../src/internal/ids.ts';
import type { Report1Document } from '../../src/report/build.ts';
import { carryForward, lastFailedIds, readLastRun, reportArtifactPaths } from '../../src/run/last-run.ts';

/** Temp roots this file creates. A list, not one `dir`: a case may make several, and
 * `reportFile` is called more than once inside a case, so a single variable drops the
 * earlier roots on the floor. */
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes `content` as the report file of a fresh project directory and returns its path. */
function reportFile(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-last-run-'));
  tempRoots.push(dir);
  const file = path.join(dir, 'report.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

type Row = Record<string, unknown>;

/**
 * A report document whose results each name a test by `id` as their test id
 * and title, in `tests/a.e2e.ts` on target `web` as agent `default`,
 * selected, with no attempts, unless a result says otherwise. `run` adds or
 * overrides run fields; a `carried` there gets the same result defaults.
 */
function document(results: readonly Row[], errors: readonly Row[] = [], run: Row = {}): Report1Document {
  const row = (result: Row): Row => ({
    testId: result['id'],
    titlePath: [result['id']],
    file: 'tests/a.e2e.ts',
    targetId: 'web',
    agent: 'default',
    selected: true,
    attempts: [],
    ...result,
  });
  const carried = run['carried'] as { results: Row[]; serialGroups?: Row[]; errors?: Row[] } | undefined;
  return {
    schemaVersion: 'report-1',
    run: {
      results: results.map(row),
      errors,
      serialGroups: [],
      targets: [{ id: 'web' }, { id: 'mobile' }],
      ...run,
      ...(carried === undefined ? {} : { carried: { serialGroups: [], errors: [], ...carried, results: carried.results.map(row) } }),
    },
  } as unknown as Report1Document;
}

/** `document` as the text of a report file. */
function report(results: readonly Row[], errors: readonly Row[] = [], run: Row = {}): string {
  return JSON.stringify(document(results, errors, run));
}

/** A result the run left out with a filter. */
const leftOut = (id: string, reason = 'title does not match --grep'): Row => ({ id, status: 'skipped', selected: false, skip: { cause: 'filtered', reason } });

const idOf = (testId: string) => resultId(testId, 'web', 'default');
const readLastFailed = async (file: string): Promise<ReadonlySet<string>> => lastFailedIds(await readLastRun(file));

describe('readLastRun and lastFailedIds', () => {
  it('collects the ids of the results that did not pass or that the run never carried out', async () => {
    const ids = await readLastFailed(
      reportFile(
        report([
          { id: 'passed', status: 'passed' },
          { id: 'flaky', status: 'flaky' },
          { id: 'failed', status: 'failed' },
          { id: 'timed-out', status: 'timed-out' },
          { id: 'interrupted', status: 'interrupted' },
          { id: 'explicit', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } },
          { id: 'filtered', status: 'skipped', skip: { cause: 'filtered', reason: 'tag filter did not match' } },
          { id: 'setup-failed', status: 'skipped', skip: { cause: 'setup-failed', reason: 'setup for session "user" failed' } },
          { id: 'predecessor', status: 'skipped', skip: { cause: 'serial-predecessor-failed', reason: 'step 1 failed' } },
          { id: 'hook', status: 'skipped', skip: { cause: 'hook-failed', reason: 'beforeAll failed' } },
          { id: 'worker', status: 'skipped', skip: { cause: 'infrastructure-unavailable', reason: 'worker process exited' } },
          { id: 'limit', status: 'skipped', skip: { cause: 'failure-limit', reason: 'the run stopped at its failure limit' } },
          { id: 'no-skip', status: 'skipped' },
        ]),
      ),
    );
    expect([...ids]).toEqual(['failed', 'timed-out', 'interrupted', 'setup-failed', 'predecessor', 'hook', 'worker', 'limit'].map(idOf));
  });

  it('is empty when every result passed, and names a test once however many of its repeats failed', async () => {
    expect((await readLastFailed(reportFile(report([{ id: 'a', status: 'passed' }])))).size).toBe(0);
    const repeated = await readLastFailed(
      reportFile(report([{ id: 'a', status: 'passed', repeat: 0 }, { id: 'a', status: 'failed', repeat: 1 }, { id: 'a', status: 'failed', repeat: 2 }])),
    );
    expect([...repeated]).toEqual([idOf('a')]);
  });

  it('names every selected test in the scope of a failed suite hook, and nothing outside it', async () => {
    const results = [
      { id: 'in-scope', titlePath: ['teardown', 'in-scope'], status: 'passed' },
      { id: 'nested', titlePath: ['teardown', 'inner', 'nested'], status: 'passed' },
      { id: 'prefix-sibling', titlePath: ['teardown-other', 'prefix-sibling'], status: 'passed' },
      { id: 'separator-sibling', titlePath: ['teardown \u203a inner', 'separator-sibling'], status: 'passed' },
      { id: 'file-scope', titlePath: ['file-scope'], status: 'passed' },
      { id: 'other-file', file: 'tests/b.e2e.ts', titlePath: ['teardown', 'other-file'], status: 'passed' },
      { id: 'other-target', targetId: 'mobile', titlePath: ['teardown', 'other-target'], status: 'passed' },
      { id: 'unselected', titlePath: ['teardown', 'unselected'], status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'grep' } },
    ];
    const scope = { file: 'tests/a.e2e.ts', targetId: 'web', titlePath: ['teardown'] };
    const afterAll = { code: 'HOOK_FAILED', phase: 'afterAll', scopeId: 'teardown', scope };
    expect([...(await readLastFailed(reportFile(report(results, [afterAll]))))]).toEqual(['in-scope', 'nested'].map(idOf));

    const fileScope = { ...afterAll, phase: 'beforeAll', scopeId: 'file', scope: { ...scope, titlePath: [] } };
    expect([...(await readLastFailed(reportFile(report(results, [fileScope]))))]).toEqual(
      ['in-scope', 'nested', 'prefix-sibling', 'separator-sibling', 'file-scope'].map(idOf),
    );

    // Control: a run error that is not a suite hook's selects nothing more.
    const cleanup = { code: 'CLEANUP_TIMEOUT', phase: 'cleanup' };
    expect((await readLastFailed(reportFile(report(results, [cleanup])))).size).toBe(0);
  });

  it('names every selected test for a failed suite hook whose scope the report does not say', async () => {
    const results = [
      { id: 'a', status: 'passed' },
      { id: 'b', file: 'tests/b.e2e.ts', status: 'passed' },
      { id: 'unselected', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'grep' } },
      // A report older than `selected` does not say it.
      { id: 'legacy', status: 'passed', selected: undefined },
    ];
    const unscoped = { code: 'HOOK_FAILED', phase: 'afterAll', scopeId: 'file' };
    expect([...(await readLastFailed(reportFile(report(results, [unscoped]))))]).toEqual(['a', 'b', 'legacy'].map(idOf));
  });

  it('is NO_LAST_RUN when no report exists, with the path and the way out', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-last-run-'));
    tempRoots.push(dir);
    const missing = path.join(dir, 'report.json');
    await expect(readLastRun(missing)).rejects.toMatchObject({
      code: 'NO_LAST_RUN',
      category: 'configuration',
      message: `--last-failed needs the report of a previous run, and none is at ${missing}; run once without the flag first`,
    });
  });

  it('is NO_LAST_RUN when the file is not JSON or not a report-1 document', async () => {
    await expect(readLastRun(reportFile('{'))).rejects.toMatchObject({
      code: 'NO_LAST_RUN',
      message: expect.stringMatching(/^--last-failed found no report in .*report\.json: /u),
    });
    for (const content of [
      'null',
      '[]',
      '{"schemaVersion":"report-2","run":{"results":[]}}',
      '{"schemaVersion":"report-1","run":{}}',
      '{"schemaVersion":"report-1","run":{"results":[null]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a"}]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"skipped","skip":"later"}]}}',
      '{"schemaVersion":"report-1","run":{"results":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[{"phase":1}],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[{"phase":"afterAll","scope":{"file":"a.e2e.ts","targetId":"web"}}],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"passed","file":"a.e2e.ts","titlePath":["a"]}],"errors":[],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"passed","file":"a.e2e.ts","titlePath":["a"],"attempts":[{}]}],"errors":[],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"passed","file":"a.e2e.ts","titlePath":["a"],"attempts":[{"artifacts":[null]}]}],"errors":[],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"passed","file":"a.e2e.ts","titlePath":["a"],"attempts":[{"artifacts":[{"path":1}]}]}],"errors":[],"serialGroups":[]}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[],"serialGroups":[{"id":"g"}]}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[],"serialGroups":[],"carried":{"results":[{"id":"a"}],"errors":[],"serialGroups":[]}}}',
      '{"schemaVersion":"report-1","run":{"results":[],"errors":[],"serialGroups":[],"carried":{"results":[]}}}',
    ]) {
      await expect(readLastRun(reportFile(content)), content).rejects.toMatchObject({
        code: 'NO_LAST_RUN',
        message: expect.stringMatching(/^--last-failed needs a report-1 document at .*report\.json, which holds something else; run once without the flag to write one$/u),
      });
    }
  });
});

describe('carryForward', () => {
  /** `carryForward` with the rerun having collected the tests its report has rows for, unless `collected` says more, and failed to collect `uncollected`. */
  const carry = (lastRun: Report1Document, current: Report1Document, collected: readonly string[] = [], uncollected: readonly string[] = []) =>
    carryForward(lastRun, current, {
      testIds: new Set([...current.run.results.map((result) => result.testId), ...collected]),
      uncollectedFiles: new Set(uncollected),
    });
  const failed = (id: string, extra: Row = {}): Row => ({ id, status: 'failed', attempts: [{ artifacts: [{ path: `web/${id}/attempt-0/failure.png` }] }], ...extra });
  const passed = (id: string, extra: Row = {}): Row => ({ id, status: 'passed', attempts: [{ artifacts: [] }], ...extra });
  const carriedIds = (carried: ReturnType<typeof carryForward>) => carried?.results.map((result) => result.testId);
  const scope = { file: 'tests/a.e2e.ts', targetId: 'web', titlePath: ['teardown'] };
  const afterAll = { code: 'HOOK_FAILED', phase: 'afterAll', scopeId: 'teardown', scope };
  const inScope = (status: (id: string, extra?: Row) => Row) => status('in-scope', { titlePath: ['teardown', 'in-scope'] });

  it('carries what the run before owed and another filter left out, as that run reported it', () => {
    const before = document([failed('broken'), { id: 'limit', status: 'skipped', skip: { cause: 'failure-limit', reason: 'stopped' } }, passed('fine')]);
    const carried = carry(before, document([passed('broken'), leftOut('limit'), leftOut('fine', 'did not fail in the last run')]));
    expect(carriedIds(carried)).toEqual(['limit']);
    expect(carried?.results[0]).toEqual(before.run.results[1]);
    expect(carried?.errors).toEqual([]);
    // What the rerun ran is its own result now, passed or not; nothing owed left out is nothing carried.
    expect(carry(before, document([failed('broken'), passed('limit'), leftOut('fine')]))).toBeUndefined();
  });

  it('keeps a test owed across consecutive reruns until one runs it, and the next --last-failed selects it', () => {
    const first = document([failed('a'), failed('b')]);
    const carriedOnce = carry(first, document([passed('a'), leftOut('b')]));
    expect(carriedIds(carriedOnce)).toEqual(['b']);
    const second = document([passed('a'), leftOut('b')], [], { carried: carriedOnce });
    expect([...lastFailedIds(second)]).toEqual([idOf('b')]);

    // Left out again: still the first run's row, not the filtered one in between.
    expect(carry(second, document([leftOut('a', 'did not fail in the last run'), leftOut('b')]))?.results).toEqual([first.run.results[1]]);
    // Run again, it is the rerun's own result.
    expect(carry(second, document([leftOut('a'), passed('b')]))).toBeUndefined();
    // A test the rerun no longer has cannot run again.
    expect(carry(second, document([leftOut('a')]))).toBeUndefined();
  });

  it('carries a suite hook failure while its scope holds a carried test, and drops it once the scope ran again', () => {
    const before = document([inScope(passed), failed('elsewhere', { file: 'tests/b.e2e.ts' })], [afterAll, { code: 'CLEANUP_TIMEOUT', phase: 'cleanup' }]);
    const narrowed = carry(before, document([leftOut('in-scope'), passed('elsewhere', { file: 'tests/b.e2e.ts' })]));
    expect(carriedIds(narrowed)).toEqual(['in-scope']);
    expect(narrowed?.errors).toEqual([afterAll]);

    // The scope ran again and the hook passed: resolved. It failed again: the rerun reports it itself, once.
    const elsewhere = passed('elsewhere', { file: 'tests/b.e2e.ts' });
    expect(carry(before, document([inScope(passed), elsewhere]))).toBeUndefined();
    expect(carry(before, document([inScope(passed), elsewhere], [afterAll]))).toBeUndefined();

    // A hook failure carried from further back stays carried with its scope.
    const second = document([leftOut('in-scope'), passed('elsewhere', { file: 'tests/b.e2e.ts' })], [], { carried: narrowed });
    expect(carry(second, document([leftOut('in-scope'), leftOut('elsewhere')]))?.errors).toEqual([afterAll]);
  });

  it('resolves a hook whose scope ran again without it failing, though another filter left part of the scope out', () => {
    const sibling = (status: (id: string, extra?: Row) => Row) => status('sibling', { titlePath: ['teardown', 'sibling'] });
    const before = document([inScope(passed), sibling(passed)], [afterAll]);
    expect(carry(before, document([inScope(passed), leftOut('sibling')]))).toBeUndefined();
    // Failing again it is the rerun's own error, and the sibling it left out stays owed.
    const again = carry(before, document([inScope(passed), leftOut('sibling')], [afterAll]));
    expect(carriedIds(again)).toEqual(['sibling']);
    expect(again?.errors).toEqual([]);
    // A scope test the rerun selected but never ran does not show the hook passing.
    const limited = { id: 'in-scope', titlePath: ['teardown', 'in-scope'], status: 'skipped', skip: { cause: 'failure-limit', reason: 'stopped' } };
    expect(carry(before, document([limited, leftOut('sibling')]))?.errors).toEqual([afterAll]);
  });

  it('carries a test on a target or agent the rerun did not select, while the test and the target are still there', () => {
    const before = document([failed('a'), failed('a', { targetId: 'mobile', id: 'a-mobile', testId: 'a' }), failed('a', { agent: 'other', id: 'a-other', testId: 'a' })]);
    const onWeb = carry(before, document([passed('a')]));
    expect(onWeb?.results.map((result) => [result.targetId, result.agent])).toEqual([
      ['mobile', 'default'],
      ['web', 'other'],
    ]);
    // A target the config no longer has cannot run it again.
    expect(carry(before, document([passed('a'), passed('a', { agent: 'other', id: 'a-other', testId: 'a' })], [], { targets: [{ id: 'web' }] }))).toBeUndefined();
  });

  it('carries a setup whose afterAll failed when the rerun needed none of its sessions, so the report has no row for it', () => {
    const setupScope = { ...afterAll, scopeId: 'file', scope: { file: 'tests/auth.e2e.ts', targetId: 'web', titlePath: [] } };
    const signIn = passed('sign in', { kind: 'setup', file: 'tests/auth.e2e.ts' });
    const before = document([signIn, passed('signed in'), failed('unrelated')], [setupScope]);
    const narrowed = document([leftOut('signed in'), passed('unrelated')]);
    const carried = carry(before, narrowed, ['sign in']);
    expect(carriedIds(carried)).toEqual(['sign in']);
    expect(carried?.errors).toEqual([setupScope]);
    // A setup the rerun no longer collects is gone with its debt.
    expect(carry(before, narrowed)).toBeUndefined();
  });

  it('carries a test in a file a narrowed rerun found but could not collect, and drops it once the file is gone', () => {
    const before = document([failed('a'), failed('b', { file: 'tests/b.e2e.ts' })]);
    const narrowed = document([passed('a')]);
    expect(carriedIds(carry(before, narrowed, [], ['tests/b.e2e.ts']))).toEqual(['b']);
    expect(carry(before, narrowed)).toBeUndefined();
  });

  it("carries a serial member's group, where its attempts live", () => {
    const group = { id: 'group', attempts: [{ artifacts: [{ path: 'web/group/attempt-0/trace.zip' }] }] };
    const before = document([failed('member', { serialGroupId: 'group', attempts: [] }), failed('other')], [], { serialGroups: [group] });
    const carried = carry(before, document([leftOut('member'), passed('other')]));
    expect(carriedIds(carried)).toEqual(['member']);
    expect(carried?.serialGroups).toEqual([group]);
  });

  it('names every artifact file a report points at, its carried ones included', () => {
    const group = { id: 'group', attempts: [{ artifacts: [{ path: 'web/group/attempt-0/trace.zip' }, { url: 'https://hosted.example/v.mp4' }] }] };
    const carried = { results: [failed('old')], serialGroups: [group] };
    const paths = reportArtifactPaths(document([failed('new'), passed('fine')], [], { carried }));
    expect([...paths].toSorted()).toEqual(['web/group/attempt-0/trace.zip', 'web/new/attempt-0/failure.png', 'web/old/attempt-0/failure.png']);
  });

  it('reads the tests a report carries back as ones to run again', async () => {
    expect([...(await readLastFailed(reportFile(report([passed('a')], [], { carried: { results: [failed('owed')] } }))))]).toEqual([idOf('owed')]);
  });
});
