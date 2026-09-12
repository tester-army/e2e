/** report-1 run status: `blocked` needs every failing result blockable and no run-level error. */

import { describe, expect, it } from 'vitest';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import type { SerializedError } from '../../src/internal/errors.ts';
import { uuidv7 } from '../../src/internal/ids.ts';
import { buildReport, type BuildReportOptions } from '../../src/report/build.ts';
import type { AttemptRecord, ResultRecord } from '../../src/run/records.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const AT = '2026-01-01T00:00:00.000Z';

const target = {
  name: 'web',
  index: 0,
  platform: 'web',
  engine: undefined,
  app: { base: undefined, site: undefined, environment: 'test', identity: undefined, command: undefined, readyUrl: undefined, services: [] },
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

function failedResult(error: SerializedError): ResultRecord {
  return {
    test: {
      kind: 'test',
      title: 'case',
      titlePath: ['suite', 'case'],
      declarationIndex: 0,
      sessions: [],
      source: undefined,
      file: 'tests/case.e2e.ts',
      id: 'tests/case.e2e.ts::suite::case',
      serialId: undefined,
    },
    target,
    agent: 'default',
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

describe('run status derivation', () => {
  it('is blocked when every failing result carries a blockable code', () => {
    const document = build({ results: [failedResult(blocked)] });
    expect(document.run.status).toBe('blocked');
  });

  it('stays failed when one result failed on the product', () => {
    const document = build({ results: [failedResult(blocked), failedResult(productFailure)] });
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
