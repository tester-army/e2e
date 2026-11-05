import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report } from 'e2e';
import { digestReport, type HistoryRun } from '../../src/digest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The report-1 fixture core's schema test accepts: the shape every synthetic report starts from. */
export function baseReport(): Report {
  return JSON.parse(readFileSync(path.join(here, '../../../e2e/schema/fixtures/report-v1.valid.json'), 'utf8')) as Report;
}

type Result = Report['run']['results'][number];
type Attempt = Result['attempts'][number];

/** One test's outcome in a synthetic run. */
export interface FakeResult {
  testId: string;
  status: Result['status'];
  targetId?: string;
  agent?: string;
  /** Attempt statuses; derived from `status` when absent. */
  attempts?: Attempt['status'][];
  /** The category of every failed attempt's error, a flaky result's first attempt included. */
  errorCategory?: 'test' | 'infrastructure' | 'configuration';
  errorCode?: string;
  durationMs?: number;
  /** Cache modes of the agent steps in the final attempt. */
  cache?: ('self-finalized' | 'agent-concluded' | 'missed')[];
  costUsd?: number;
}

let counter = 0;

/** A schema-shaped report with the given results, built on the fixture's first passing result. */
export function makeReport(
  results: readonly FakeResult[],
  options: { commit?: string; dirty?: boolean; startedAt?: string; explore?: boolean } = {},
): Report {
  const report = baseReport();
  const template = report.run.results.find((result) => result.attempts.length > 0)!;
  const step = template.attempts[0]!.steps[0]!;
  // The fixture's passing attempt carries an error to exercise the schema; a synthetic attempt gets one only when it failed.
  const { error: _fixtureError, ...attemptTemplate } = template.attempts[0]!;
  counter += 1;
  const startedAt = options.startedAt ?? new Date(Date.UTC(2026, 10, 1, 0, counter)).toISOString();
  const run = report.run as { -readonly [K in keyof Report['run']]: Report['run'][K] };
  run.id = `run-${String(counter).padStart(4, '0')}`;
  run.startedAt = startedAt;
  run.finishedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  run.serialGroups = [];
  if (options.commit) run.vcs = { commit: options.commit.padEnd(40, '0'), branch: 'main', ...(options.dirty ? { dirty: true } : {}) };
  if (options.explore) run.explore = {} as NonNullable<Report['run']['explore']>;
  run.results = results.map((fake) => {
    const statuses =
      fake.attempts ??
      (fake.status === 'flaky' ? ['failed', 'passed'] : fake.status === 'passed' ? ['passed'] : [fake.status === 'timed-out' ? 'timed-out' : 'failed']);
    return {
      ...template,
      id: `${run.id}-${fake.testId}`,
      testId: fake.testId,
      titlePath: ['suite', fake.testId],
      file: 'tests/suite.e2e.ts',
      targetId: fake.targetId ?? 'web',
      agent: fake.agent ?? 'default',
      status: fake.status,
      selected: true,
      attempts: statuses.map((status, index) => {
        const last = index === statuses.length - 1;
        const failed = status === 'failed' || status === 'timed-out';
        return {
          ...attemptTemplate,
          index,
          status,
          durationMs: fake.durationMs ?? 1000,
          steps: last
            ? (fake.cache ?? []).map((mode) => ({
                ...step,
                cache: { mode, replayedActions: 0, totalActions: 1, ...(mode === 'self-finalized' ? {} : { reason: 'no-entry' as const }) },
                ...(fake.costUsd === undefined
                  ? {}
                  : {
                      model: {
                        provider: 'example',
                        model: 'model-A',
                        endpoint: 'example',
                        adapterVersion: '1',
                        policyVersion: '1',
                        calls: 1,
                        tokenAccounting: 'provider',
                        peakTokensPerCall: 120,
                        inputTokens: 100,
                        outputTokens: 20,
                        estimatedCostUsd: fake.costUsd,
                      },
                    }),
              }))
            : [],
          ...(failed
            ? {
                error: {
                  category: fake.errorCategory ?? 'test',
                  code: fake.errorCode ?? 'ASSERTION_FAILED',
                  message: 'expected "secret text" to be visible',
                  retryable: false,
                },
              }
            : {}),
        } as Attempt;
      }),
    } as Result;
  });
  return report;
}

/** Digests of a sequence of runs, each a list of results. */
export function history(runs: readonly (readonly FakeResult[])[], commit?: (index: number) => string): HistoryRun[] {
  return runs.map((results, index) => digestReport(makeReport(results, commit ? { commit: commit(index) } : {})));
}

/**
 * Runs of one test whose statuses follow `statuses`: `p` passed, `f` failed,
 * `r` retry pass after a test failure, `x` retry pass after an infrastructure
 * failure, `i` infrastructure failure.
 */
export function pattern(testId: string, statuses: string): FakeResult[][] {
  const infra = { errorCategory: 'infrastructure', errorCode: 'WORKER_INIT_FAILED' } as const;
  const byLetter: Record<string, Omit<FakeResult, 'testId'>> = {
    p: { status: 'passed' },
    f: { status: 'failed' },
    r: { status: 'flaky' },
    x: { status: 'flaky', ...infra },
    i: { status: 'failed', ...infra },
  };
  return [...statuses].map((letter) => [{ testId, ...byLetter[letter]! }]);
}
