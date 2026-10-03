/**
 * report-1 documents built from run records: the run status (`blocked` needs
 * every failing result blockable and no run-level error), result tags, the
 * result source made relative to the project root, and the run limits.
 */

import { describe, expect, it } from 'vitest';
import { resolveConfig, type ResolvedConfig, type ResolvedTarget } from '../../src/config/resolve.ts';
import type { SerializedError } from '../../src/internal/errors.ts';
import { uuidv7 } from '../../src/internal/ids.ts';
import { buildReport, type BuildReportOptions } from '../../src/report/build.ts';
import type { AttemptRecord, ResultRecord, SerialAttemptRecord, SerialGroupRecord } from '../../src/run/records.ts';
import type { StepRecord } from '../../src/run/steps.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const AT = '2026-01-01T00:00:00.000Z';

const target = {
  name: 'web',
  index: 0,
  platform: 'web',
  engine: undefined,
  app: { base: undefined, site: undefined, environment: 'test', identity: undefined },
} as unknown as ResolvedTarget;

function failedAttempt(error: SerializedError): AttemptRecord {
  return {
    id: uuidv7(),
    index: 0,
    status: 'failed',
    startedAt: AT,
    durationMs: 10,
    steps: [],
    artifacts: [],
    error,
    secondaryErrors: [],
    cleanup: 'complete',
  };
}

/** A failed result for one test titled `title`; two in one report need distinct titles, as a run gives each result its own id. */
function failedResult(error: SerializedError, title = 'case'): ResultRecord {
  return {
    test: {
      kind: 'test',
      title,
      titlePath: ['suite', title],
      declarationIndex: 0,
      sessions: [],
      tags: [],
      source: undefined,
      file: 'tests/case.e2e.ts',
      id: `tests/case.e2e.ts::suite::${title}`,
      serialId: undefined,
    },
    target,
    agent: 'default',
    repeat: 0,
    status: 'failed',
    selected: true,
    attempts: [failedAttempt(error)],
  };
}

const blocked: SerializedError = {
  category: 'test',
  code: 'STEP_BUDGET_EXHAUSTED',
  message: 'the agent ran out of model calls',
  retryable: false,
};

const productFailure: SerializedError = {
  category: 'test',
  code: 'ASSERTION_FAILED',
  message: 'expected the dashboard',
  retryable: false,
};

const reportWriteFailure: SerializedError = {
  category: 'infrastructure',
  code: 'REPORT_WRITE_FAILED',
  message: 'the JUnit report could not be written: EACCES',
  retryable: false,
  phase: 'report',
};

function build(overrides: Partial<BuildReportOptions>): ReturnType<typeof buildReport> {
  const document = buildReport({
    runId: uuidv7(),
    config: undefined,
    startedAt: AT,
    status: 'failed',
    exitCode: 1,
    results: [],
    serialGroups: [],
    runErrors: [],
    targetProvenance: new Map(),
    ...overrides,
  });
  assertValidReport(document);
  return document;
}

describe('result tags', () => {
  it('carries the tags a test declares, an empty list when it declares none', () => {
    const plain = failedResult(productFailure);
    const tagged: ResultRecord = {
      ...plain,
      test: { ...plain.test, title: 'tagged', titlePath: ['suite', 'tagged'], id: 'tests/case.e2e.ts::suite::tagged', declarationIndex: 1, tags: ['smoke', 'billing'] },
    };
    const document = build({ results: [plain, tagged] });
    expect(document.run.results.map((result) => result.tags)).toEqual([[], ['smoke', 'billing']]);
  });
});

describe('result source', () => {
  const config = { projectRoot: '/repo/app', targets: [] } as unknown as ResolvedConfig;

  function declaredAt(file: string): ResultRecord {
    const plain = failedResult(productFailure);
    return { ...plain, test: { ...plain.test, source: { file, line: 7, column: 3 } } };
  }

  it('keeps a file under the project root relative to it', () => {
    const document = build({ config, results: [declaredAt('/repo/app/tests/case.e2e.ts')] });
    expect(document.run.results[0]!.source).toEqual({ file: 'tests/case.e2e.ts', line: 7, column: 3 });
  });

  it('does not treat a sibling directory sharing the root prefix as inside the project', () => {
    const document = build({ config, results: [declaredAt('/repo/app-shared/helpers.ts')] });
    expect(document.run.results[0]!.source).toEqual({ file: 'tests/case.e2e.ts', line: 7, column: 3 });
  });

  it('keeps a file under a root of / or one ending in a separator', () => {
    const withRoot = (projectRoot: string) => ({ ...config, projectRoot }) as ResolvedConfig;
    const atRoot = build({ config: withRoot('/'), results: [declaredAt('/repo/app/tests/case.e2e.ts')] });
    expect(atRoot.run.results[0]!.source).toEqual({ file: 'repo/app/tests/case.e2e.ts', line: 7, column: 3 });
    const trailing = build({ config: withRoot('/repo/app/'), results: [declaredAt('/repo/app/tests/case.e2e.ts')] });
    expect(trailing.run.results[0]!.source).toEqual({ file: 'tests/case.e2e.ts', line: 7, column: 3 });
  });
});

describe('run status derivation', () => {
  it('is blocked when every failing result carries a blockable code', () => {
    const document = build({ results: [failedResult(blocked)] });
    expect(document.run.status).toBe('blocked');
  });

  it('stays failed when one result failed on the product', () => {
    const document = build({ results: [failedResult(blocked, 'blocked'), failedResult(productFailure, 'product')] });
    expect(document.run.status).toBe('failed');
  });

  it('keeps a run-level error visible instead of calling the run blocked', () => {
    const document = build({
      status: 'error',
      exitCode: 3,
      results: [failedResult(blocked)],
      runErrors: [{ error: reportWriteFailure }],
    });
    expect(document.run.status).toBe('error');
    expect(document.run.errors.map((error) => error.code)).toEqual(['REPORT_WRITE_FAILED']);
  });
});

/** One attempt of serial group `g1`: `first` passed, `second` failed with `error`. */
function serialAttempt(index: number, error: SerializedError): SerialAttemptRecord {
  const member = (memberIndex: number, testId: string) => ({
    id: uuidv7(),
    index: memberIndex,
    testId,
    startedAt: AT,
    durationMs: 5,
    steps: [],
    secondaryErrors: [],
  });
  return {
    id: uuidv7(),
    index,
    status: 'failed',
    startedAt: AT,
    durationMs: 10,
    members: [
      { ...member(0, 'tests/case.e2e.ts::suite::first'), status: 'passed' },
      { ...member(1, 'tests/case.e2e.ts::suite::second'), status: 'failed', error },
    ],
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
  };
}

/** The member results and the group record of serial group `g1`, which failed on its last attempt with the errors given, one per attempt. */
function failedSerialGroup(...errors: SerializedError[]): Pick<BuildReportOptions, 'results' | 'serialGroups'> {
  const member = (title: string, index: number, status: ResultRecord['status']): ResultRecord => {
    const plain = failedResult(productFailure, title);
    return { ...plain, test: { ...plain.test, declarationIndex: index, serialId: 'suite' }, status, attempts: [], serialGroupId: 'g1' };
  };
  const group: SerialGroupRecord = {
    id: 'g1',
    serialId: 'suite',
    declarationIndex: 0,
    file: 'tests/case.e2e.ts',
    titlePath: ['suite'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: ['tests/case.e2e.ts::suite::first', 'tests/case.e2e.ts::suite::second'],
    status: 'failed',
    attempts: errors.map((error, index) => serialAttempt(index, error)),
  };
  return { results: [member('first', 0, 'passed'), member('second', 1, 'failed')], serialGroups: [group] };
}

describe('run status derivation for a serial group', () => {
  it('is blocked when the failing member of the last attempt carries a blockable code', () => {
    expect(build(failedSerialGroup(blocked)).run.status).toBe('blocked');
  });

  it('stays failed when the failing member of the last attempt failed on the product', () => {
    expect(build(failedSerialGroup(productFailure)).run.status).toBe('failed');
  });

  it('reads the last attempt, not an earlier blocked one', () => {
    expect(build(failedSerialGroup(blocked, productFailure)).run.status).toBe('failed');
    expect(build(failedSerialGroup(productFailure, blocked)).run.status).toBe('blocked');
  });
});

describe('error stacks', () => {
  it('never carries a stack into the report, from a step, an attempt, a serial member, or the run', () => {
    const stack = 'Error: boom\n    at /Users/someone/project/tests/case.e2e.ts:3:9';
    const withStack: SerializedError = { ...productFailure, stack };
    const plain = failedResult(withStack, 'plain');
    const step: StepRecord = {
      id: uuidv7(),
      index: 0,
      kind: 'assertion',
      api: 'expect.toBe',
      label: 'toBe',
      status: 'failed',
      startedAt: AT,
      durationMs: 1,
      events: [],
      error: withStack,
      artifacts: [],
    };
    const result: ResultRecord = {
      ...plain,
      attempts: [{ ...plain.attempts[0]!, secondaryErrors: [withStack], steps: [step] }],
    };
    const serial = failedSerialGroup(withStack);
    const document = build({
      status: 'error',
      exitCode: 3,
      results: [result, ...serial.results],
      serialGroups: serial.serialGroups,
      runErrors: [{ error: { ...reportWriteFailure, stack } }],
    });
    const json = JSON.stringify(document);
    expect(json).toContain('expected the dashboard');
    expect(json).not.toContain('"stack"');
    expect(json).not.toContain('/Users/someone');
  });
});

describe('run limits', () => {
  it('fills the block from the largest per-agent values and the fixed ones, in the report-1 shape', () => {
    const config = resolveConfig(
      {
        targets: [{ name: 'web', platform: 'web' }],
        agents: {
          default: { maxObservationBytes: 4_096, maxInputTokens: 200_000 },
          ux: { maxObservationBytes: 65_536, maxInputTokens: 8_000 },
        },
      },
      { projectRoot: '/repo/app', env: {}, cli: { agents: ['ux'] } },
    );
    const document = build({ config, status: 'passed', exitCode: 0 });
    expect(document.run.limits).toEqual({
      maxAgentContextBytes: 16_384,
      maxLedgerBytes: 8_192,
      maxObservationBytes: 65_536,
      maxEventsPerStep: 1_000,
      maxModelTokensPerCall: 200_000,
    });
  });

  it('reports the defaults when the run failed before the config resolved', () => {
    expect(build({}).run.limits).toEqual({
      maxAgentContextBytes: 16_384,
      maxLedgerBytes: 8_192,
      maxObservationBytes: 262_144,
      maxEventsPerStep: 1_000,
      maxModelTokensPerCall: 64_000,
    });
  });
});
