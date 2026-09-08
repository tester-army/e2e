/**
 * Builders for report-1 documents in tests. Every field has a plain default,
 * and an overrides object replaces the ones a test cares about, so a test
 * states only what it is about.
 */

import type { ResolvedLimits } from '../../src/config/agent.ts';
import { ENGINE_SPI_VERSION } from '../../src/engine/contract.ts';
import type {
  Report1Document,
  ReportAttempt,
  ReportError,
  ReportResult,
  ReportStep,
  ReportTarget,
} from '../../src/report/build.ts';

export const REPORT_AT = '2026-01-01T00:00:00.000Z';

const SOURCE = { file: 'tests/auth.e2e.ts', line: 3, column: 1 };

const LIMITS: ResolvedLimits = {
  maxAgentContextBytes: 1,
  maxLedgerBytes: 1,
  maxObservationBytes: 1,
  maxEventsPerStep: 1,
  maxModelTokensPerCall: 1,
};

export function reportError(overrides: Partial<ReportError> = {}): ReportError {
  return {
    category: 'test',
    code: 'ASSERTION_FAILED',
    message: 'expected "Sign in" to be visible',
    retryable: false,
    ...overrides,
  };
}

export function reportStep(overrides: Partial<ReportStep> = {}): ReportStep {
  return {
    id: 'step-0',
    index: 0,
    kind: 'locator',
    api: 'locator.tap',
    label: 'tap Sign in',
    source: SOURCE,
    status: 'passed',
    startedAt: REPORT_AT,
    durationMs: 100,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

export function reportAttempt(overrides: Partial<ReportAttempt> = {}): ReportAttempt {
  return {
    id: 'attempt-1',
    index: 0,
    status: 'passed',
    startedAt: REPORT_AT,
    durationMs: 1234,
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
    steps: [],
    ...overrides,
  };
}

export function reportResult(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    id: 'result-1',
    testId: 'test-1',
    kind: 'test',
    declarationIndex: 0,
    titlePath: ['auth', 'signs in'],
    file: 'tests/auth.e2e.ts',
    source: SOURCE,
    targetId: 'web',
    platform: 'web',
    status: 'passed',
    attempts: [reportAttempt()],
    ...overrides,
  };
}

export function reportTarget(overrides: Partial<ReportTarget> = {}): ReportTarget {
  return {
    id: 'web',
    index: 0,
    platform: 'web',
    environment: 'local',
    testIdAttribute: 'data-testid',
    engine: { name: 'playwright', version: '0.6.1', spiVersion: ENGINE_SPI_VERSION },
    capabilities: [],
    artifactCapabilities: [],
    stateCapability: false,
    ...overrides,
  };
}

/** A whole document; `overrides` replaces fields of `run`. */
export function reportDocument(overrides: Partial<Report1Document['run']> = {}): Report1Document {
  return {
    schemaVersion: 'report-1',
    run: {
      id: 'run-1',
      specVersion: '0.1',
      runner: { name: 'e2e', version: '0.0.0' },
      status: 'passed',
      exitCode: 0,
      startedAt: REPORT_AT,
      finishedAt: REPORT_AT,
      project: { id: 'project', configDigest: '0'.repeat(64) },
      environment: { ci: false, trustNoticeShown: false, os: 'test', arch: 'x64', runtime: 'node' },
      targets: [],
      serialGroups: [],
      results: [],
      errors: [],
      summary: { discovered: 0, selected: 0, executed: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      limits: LIMITS,
      usage: {
        discoveredResults: 0,
        maxAgentContextBytes: 0,
        maxLedgerBytes: 0,
        maxObservationBytes: 0,
        artifactBytes: 0,
        downloads: 0,
        events: 0,
        modelTokens: 0,
        maxModelCallsInStep: 0,
        maxActionStepsInStep: 0,
      },
      ...overrides,
    },
  };
}
