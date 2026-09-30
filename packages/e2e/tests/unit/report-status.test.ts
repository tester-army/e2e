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
import type { AttemptRecord, ResultRecord } from '../../src/run/records.ts';
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
