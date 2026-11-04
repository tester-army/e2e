import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinishedRun, Report, TestFilterContext } from 'e2e';
import { describe, expect, it } from 'vitest';
import { quarantineFilter } from '../../src/filter.ts';
import { insights } from '../../src/reporter.ts';
import { loadHistory } from '../../src/store.ts';
import { makeReport } from './helpers.ts';

function finished(report: Report, projectRoot: string): FinishedRun {
  return {
    report,
    status: report.run.status,
    exitCode: report.run.exitCode,
    projectRoot,
    reportPath: path.join(projectRoot, '.e2e', 'report.json'),
    artifactsRoot: path.join(projectRoot, '.e2e', 'results'),
    aiTracePath: undefined,
    traces: new Map(),
  } as FinishedRun;
}

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'e2e-insights-project-'));
}

const signal = new AbortController().signal;

/** Records ten runs of three tests: `stable` always passes, `often` fails every other run, `broken` fails from the sixth. */
async function recordTen(root: string): Promise<void> {
  const reporter = insights();
  for (let index = 0; index < 10; index += 1) {
    await reporter.onRunFinished!(
      finished(
        makeReport([
          { testId: 'stable', status: 'passed' },
          { testId: 'often', status: index % 2 === 0 ? 'failed' : 'passed' },
          { testId: 'broken', status: index < 5 ? 'passed' : 'failed' },
        ]),
        root,
      ),
      signal,
    );
  }
}

function context(projectRoot: string): TestFilterContext {
  return { projectRoot } as TestFilterContext;
}

const candidates = ['stable', 'often', 'broken'].map((id) => ({ id, file: 'tests/suite.e2e.ts', titlePath: ['suite', id], tags: [] }));

describe('insights reporter', () => {
  it('appends each run under .e2e/history and reports the health row', async () => {
    const root = await project();
    const reporter = insights();
    const rows = await reporter.onRunFinished!(finished(makeReport([{ testId: 'a', status: 'passed' }]), root), signal);
    expect(rows).toEqual([{ label: 'Insights', text: 'no broken, failing, or flaky tests over 1 runs (.e2e/history/runs.jsonl)' }]);
    expect((await loadHistory([path.join(root, '.e2e/history/runs.jsonl')])).runs).toHaveLength(1);
  });

  it('names flaky and broken counts once the history shows them', async () => {
    const root = await project();
    await recordTen(root);
    const rows = await insights().onRunFinished!(finished(makeReport([{ testId: 'stable', status: 'passed' }]), root), signal);
    expect(rows).toEqual([{ label: 'Insights', text: '1 broken · 1 flaky over 11 runs (.e2e/history/runs.jsonl)' }]);
  });

  it('records neither an explore run nor a run that executed nothing', async () => {
    const root = await project();
    const reporter = insights();
    expect(await reporter.onRunFinished!(finished(makeReport([{ testId: 'a', status: 'passed' }], { explore: true }), root), signal)).toBeUndefined();
    const empty = makeReport([]);
    (empty.run.summary as { executed: number }).executed = 0;
    expect(await reporter.onRunFinished!(finished(empty, root), signal)).toBeUndefined();
    expect((await loadHistory([path.join(root, '.e2e/history/runs.jsonl')])).runs).toHaveLength(0);
  });

  it('rejects bad options when constructed', () => {
    expect(() => insights({ keep: 0 })).toThrow(TypeError);
    expect(() => insights({ dir: ' ' })).toThrow(TypeError);
  });
});

describe('quarantineFilter', () => {
  it('reports what it would quarantine and leaves everything in by default', async () => {
    const root = await project();
    await recordTen(root);
    expect(await quarantineFilter().filter(candidates, context(root))).toEqual({
      exclude: {},
      note: "would quarantine 1 flaky test; set mode: 'skip' to leave them out",
    });
  });

  it('leaves flaky tests out in skip mode and never a broken one', async () => {
    const root = await project();
    await recordTen(root);
    expect(await quarantineFilter({ mode: 'skip' }).filter(candidates, context(root))).toEqual({
      exclude: { often: 'flaky in 4 of 10 runs (40%) on web' },
      note: 'quarantined 1 flaky test from 10 runs',
    });
  });

  it('runs a test the latest run saw fail, whatever its history', async () => {
    const root = await project();
    await recordTen(root);
    await insights().onRunFinished!(finished(makeReport([{ testId: 'often', status: 'failed' }]), root), signal);
    expect(await quarantineFilter({ mode: 'skip' }).filter(candidates, context(root))).toEqual({ exclude: {} });
  });

  it('leaves everything in with no history', async () => {
    expect(await quarantineFilter({ mode: 'skip' }).filter(candidates, context(await project()))).toEqual({ exclude: {} });
  });

  it('rejects a rate outside 0 through 1', () => {
    expect(() => quarantineFilter({ maxFlakeRate: 2 })).toThrow(TypeError);
  });
});
