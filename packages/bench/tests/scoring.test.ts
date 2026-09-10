import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/aggregate.ts';
import { tableCostUsd } from '../src/catalog.ts';
import type { Report } from '../src/report-data.ts';
import { scoreExplore } from '../src/score-explore.ts';
import { judgmentOutcome, scoreTests, type TaskRow } from '../src/score-tests.ts';
import type { RunScore } from '../src/score-run.ts';

function report(overrides: Partial<Report['run']>): Report {
  return {
    schemaVersion: 'report-1',
    run: {
      id: 'run',
      status: 'passed',
      startedAt: '2026-09-10T10:00:00.000Z',
      finishedAt: '2026-09-10T10:05:00.000Z',
      runner: { name: 'e2e', version: '0.11.0' },
      results: [],
      usage: { modelTokens: 0 },
      errors: [],
      ...overrides,
    },
  };
}

function test(title: string, status: string, code?: string): Report['run']['results'][number] {
  const failed = status !== 'passed' && status !== 'skipped';
  return {
    testId: title,
    titlePath: [title],
    file: 'suite.e2e.ts',
    status,
    attempts:
      status === 'skipped'
        ? []
        : [
            {
              index: 0,
              status: failed ? 'failed' : 'passed',
              durationMs: 4_000,
              steps: [
                {
                  kind: 'agent',
                  api: 'agent.act',
                  status: 'passed',
                  durationMs: 3_000,
                  metrics: { modelCalls: 3, actionSteps: 2 },
                  model: { provider: 'gateway', model: 'm', calls: 3, inputTokens: 3_000, outputTokens: 300, cacheReadTokens: 1_000, estimatedCostUsd: 0.01 },
                  events: [
                    { kind: 'model', durationMs: 900 },
                    { kind: 'observation', durationMs: 50 },
                    { kind: 'model', durationMs: 1_100 },
                  ],
                },
                {
                  kind: 'agent',
                  api: 'agent.assert',
                  status: failed ? 'failed' : 'passed',
                  durationMs: 1_000,
                  metrics: { modelCalls: 1, actionSteps: 0 },
                  model: { provider: 'gateway', model: 'm', calls: 1, inputTokens: 1_000, outputTokens: 50 },
                  events: [{ kind: 'model', durationMs: 700 }],
                  ...(failed && code !== undefined ? { error: { code, message: 'judged false' } } : {}),
                },
              ],
              ...(failed && code !== undefined ? { error: { code, message: 'judged false' } } : {}),
            },
          ],
  };
}

describe('scoreTests', () => {
  it('sums usage over the steps and keeps the failing step code', () => {
    const rows = scoreTests(report({ results: [test('bug: x', 'failed', 'ASSERTION_FAILED'), test('gap', 'skipped')] }), new Map([['bug: x', 120]]));
    expect(rows).toHaveLength(2);
    const [failed, skipped] = rows as [TaskRow, TaskRow];
    expect(failed).toMatchObject({
      id: 'suite.e2e.ts#bug: x',
      code: 'ASSERTION_FAILED',
      calls: 4,
      actions: 2,
      inputTokens: 4_000,
      outputTokens: 350,
      cacheReadTokens: 1_000,
      reasoningTokens: 120,
      costUsd: 0.01,
      // 3000 - 50 of observation on the act, the whole 1000 of the assert.
      modelMs: 3_950,
    });
    expect(skipped).toMatchObject({ status: 'skipped', code: undefined, calls: 0, costUsd: undefined });
  });
});

describe('judgmentOutcome', () => {
  const row = (title: string, status: string, code?: string): TaskRow =>
    scoreTests(report({ results: [test(title, status, code)] }), new Map())[0]!;

  it('maps the four cells from the title prefix and the outcome', () => {
    expect(judgmentOutcome(row('bug: a', 'failed', 'ASSERTION_FAILED'))).toBe('caught');
    expect(judgmentOutcome(row('bug: a', 'failed', 'ACTION_FAILED'))).toBe('caught');
    expect(judgmentOutcome(row('bug: a', 'passed'))).toBe('missed');
    expect(judgmentOutcome(row('clean: a', 'passed'))).toBe('correct');
    expect(judgmentOutcome(row('clean: a', 'failed', 'ASSERTION_FAILED'))).toBe('false-alarm');
    expect(judgmentOutcome(row('clean: a', 'failed', 'STEP_NO_CONCLUSION'))).toBe('inconclusive');
    expect(judgmentOutcome(row('bug: a', 'timed-out', 'STEP_TIMEOUT'))).toBe('inconclusive');
  });

  it('is undefined for rows outside the judgment suite', () => {
    expect(judgmentOutcome(row('scenario x', 'passed'))).toBeUndefined();
  });
});

describe('scoreExplore', () => {
  const finding = (title: string, actual: string, kind: 'issue' | 'warning' = 'issue', at = '2026-09-10T10:01:00.000Z') => ({
    kind,
    severity: 3,
    title,
    expected: 'works',
    actual,
    reportedAt: at,
    artifactId: 'shot',
  });
  const exploring = report({
    explore: {
      ended: 'finished',
      steps: [{ status: 'passed', title: 'browse' }],
      findings: [
        finding('Help link is broken', 'the Help link leads to /hlep, a 404 page'),
        finding('Help link 404', 'Help opens a not found page'),
        finding('Cart total ignores quantity', 'total should be $25.00, is $12.50'),
        finding('Footer has no contact', 'no contact email anywhere'),
        finding('Counter starts at 0', 'unlabeled counter', 'warning'),
      ],
    },
  });

  it('matches planted defects, counts duplicates, and routes the rest through adjudications', () => {
    const score = scoreExplore(exploring, [{ pattern: 'footer.*contact', verdict: 'false-positive', note: 'no contact is fine' }], false);
    expect(score.found).toEqual(['B1', 'B3']);
    expect(score.duplicates).toBe(1);
    expect(score.falsePositives).toEqual(['[issue S3] Footer has no contact']);
    expect(score.other).toEqual(['[warning S3] Counter starts at 0']);
    expect(score.evidenceRate).toBe(1);
    expect(score.firstFindingMs).toBe(60_000);
  });

  it('counts every issue on the clean garden as a false positive and ignores warnings', () => {
    const score = scoreExplore(exploring, [], true);
    expect(score.found).toEqual([]);
    expect(score.falsePositives).toHaveLength(4);
    expect(score.other).toEqual([]);
  });
});

describe('tableCostUsd', () => {
  it('prices fresh input, cached input, and output separately', () => {
    const cost = tableCostUsd({ input: 1, output: 10, cacheRead: 0.1, asOf: '2026-09-10' }, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 });
    expect(cost).toBeCloseTo(0.5 + 0.05 + 1, 6);
  });
});

describe('aggregate', () => {
  const run = (repeat: number, tasks: readonly { id: string; status: string; code?: string }[]): RunScore => ({
    arm: 'a',
    track: 'act',
    repeat,
    dir: '',
    process: { exitCode: 0, durationMs: 60_000, startedAt: '' },
    runStatus: 'passed',
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.id,
      status: task.status,
      code: task.code,
      calls: 2,
      actions: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 500,
      reasoningTokens: 0,
      costUsd: undefined,
      durationMs: 1_000,
      modelMs: 800,
    })),
    explore: undefined,
    usage: { calls: 2 * tasks.length, actions: tasks.length, inputTokens: 1_000 * tasks.length, outputTokens: 100 * tasks.length, cacheReadTokens: 500 * tasks.length, reasoningTokens: 0, costUsd: undefined, tableCostUsd: 0.001, modelMs: 800 * tasks.length },
  });

  it('reports pass rate as a mean and reliability as pass-everywhere', () => {
    const [row] = aggregate([
      run(1, [{ id: 'x', status: 'passed' }, { id: 'y', status: 'failed', code: 'STEP_NO_CONCLUSION' }, { id: 'gap', status: 'skipped' }]),
      run(2, [{ id: 'x', status: 'passed' }, { id: 'y', status: 'passed' }, { id: 'gap', status: 'skipped' }]),
    ]);
    expect(row).toMatchObject({ runs: 2, failedRuns: 0 });
    expect(row!.tasks).toMatchObject({ perRun: 3, skipped: 1, passRate: 0.75, reliability: 0.5, codes: { STEP_NO_CONCLUSION: 1 } });
    expect(row!.usage.cacheShare).toBe(0.5);
  });

  it('leaves runs without a report out of the means and counts them', () => {
    const lost: RunScore = { ...run(2, []), runStatus: undefined, process: { exitCode: -1, durationMs: 0, startedAt: '', error: 'killed' } };
    const [row] = aggregate([run(1, [{ id: 'x', status: 'passed' }]), lost]);
    expect(row).toMatchObject({ runs: 2, failedRuns: 1 });
    expect(row!.tasks?.passRate).toBe(1);
  });
});
