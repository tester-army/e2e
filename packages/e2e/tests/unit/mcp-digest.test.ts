import { describe, expect, it } from 'vitest';
import { digestReport } from '../../src/mcp/digest.ts';
import type { Report1Document, ReportResult } from '../../src/report/build.ts';

function report(results: ReportResult[], overrides: Partial<Report1Document['run']> = {}): Report1Document {
  const failed = results.filter((entry) => entry.status === 'failed' || entry.status === 'timed-out').length;
  return {
    schemaVersion: 'report-1',
    run: {
      id: 'run-1',
      specVersion: '0.1',
      runner: { name: 'e2e', version: '0.0.0' },
      status: failed > 0 ? 'failed' : 'passed',
      exitCode: failed > 0 ? 1 : 0,
      startedAt: '2026-09-08T10:00:00.000Z',
      finishedAt: '2026-09-08T10:00:12.500Z',
      project: { id: 'p', configDigest: 'd' },
      environment: { ci: false, trustNoticeShown: false, os: 'darwin', arch: 'arm64', runtime: 'node' },
      targets: [],
      serialGroups: [],
      results,
      errors: [],
      summary: {
        discovered: results.length,
        selected: results.length,
        executed: results.length,
        passed: results.length - failed,
        failed,
        flaky: 0,
        skipped: 0,
      },
      limits: { maxEventsPerStep: 1000, maxAgentContextBytes: 1, maxLedgerBytes: 1, maxObservationBytes: 1 } as Report1Document['run']['limits'],
      usage: {
        discoveredResults: results.length,
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

function result(status: ReportResult['status'], attempts: ReportResult['attempts'] = []): ReportResult {
  return {
    id: 'r1',
    testId: 't1',
    kind: 'test',
    declarationIndex: 0,
    titlePath: ['billing', 'upgrades to Pro'],
    file: 'tests/billing.e2e.ts',
    source: { file: 'tests/billing.e2e.ts', line: 7, column: 1 },
    targetId: 'web',
    platform: 'web',
    status,
    attempts,
  };
}

describe('digestReport', () => {
  it('summarizes a passing run in a few lines', () => {
    const text = digestReport(report([result('passed')]), { reportPath: '/p/.e2e/report.json' });
    expect(text).toContain('# Run passed (exit 0)');
    expect(text).toContain('1 executed, 1 passed, 0 failed');
    expect(text).toContain('Report: /p/.e2e/report.json');
    expect(text).toContain('Every selected test passed.');
    expect(text).not.toContain('## Failed tests');
  });

  it('describes each failure with its source line, error, failing step, and artifact paths', () => {
    const text = digestReport(
      report([
        result('failed', [
          {
            id: 'a1',
            index: 0,
            status: 'failed',
            startedAt: '2026-09-08T10:00:00.000Z',
            durationMs: 3200,
            artifacts: [
              { id: 'a1:artifact:0', kind: 'screenshot', mediaType: 'image/png', path: 'web/t1/attempt-0/failure.png', redaction: 'complete', producer: { kind: 'attempt' } },
              { id: 'a1:artifact:1', kind: 'trace', mediaType: 'application/zip', redaction: 'complete', producer: { kind: 'attempt' } },
            ],
            error: { category: 'test', code: 'ASSERTION_FAILED', message: 'expected status to contain "Pro"\n  received "Free"', retryable: false, phase: 'body' },
            secondaryErrors: [],
            cleanup: 'complete',
            steps: [
              { id: 's0', index: 0, kind: 'app', api: 'app.open', label: '/settings', source: { file: 'tests/billing.e2e.ts', line: 8, column: 3 }, status: 'passed', startedAt: '', durationMs: 400, events: [], artifacts: [] },
              {
                id: 's1',
                index: 1,
                kind: 'agent',
                api: 'agent.act',
                label: 'upgrade to Pro',
                source: { file: 'tests/billing.e2e.ts', line: 9, column: 3 },
                status: 'failed',
                startedAt: '',
                durationMs: 2500,
                events: [],
                artifacts: [],
                explanation: 'the Upgrade button stayed disabled',
                metrics: { modelCalls: 3, actionSteps: 2, observationBytes: 1, contextBytes: 0, ledgerBytes: 0 },
                error: { category: 'test', code: 'ACTION_FAILED', message: 'the Upgrade button stayed disabled', retryable: false },
              },
            ],
          },
        ]),
      ]),
      { artifactsRoot: '/p/.e2e/artifacts' },
    );
    expect(text).toContain('## Failed tests (1)');
    expect(text).toContain('### billing › upgrades to Pro');
    expect(text).toContain('- File: tests/billing.e2e.ts:7');
    expect(text).toContain('ASSERTION_FAILED (test): expected status to contain "Pro" received "Free"');
    expect(text).toContain('Failing step: agent.act "upgrade to Pro" at tests/billing.e2e.ts:9 (failed, 2.5 s); ACTION_FAILED');
    expect(text).toContain('agent: the Upgrade button stayed disabled; 3 model calls, 2 actions');
    expect(text).toContain('- Artifacts: screenshot /p/.e2e/artifacts/web/t1/attempt-0/failure.png');
    expect(text).not.toContain('app.open');
  });

  it('lists run-level errors when nothing ran', () => {
    const text = digestReport(
      report([], {
        status: 'error',
        exitCode: 2,
        errors: [{ category: 'configuration', code: 'CONFIG_NOT_FOUND', message: 'no e2e.config.ts found', retryable: false, phase: 'config' }],
      }),
    );
    expect(text).toContain('# Run error (exit 2)');
    expect(text).toContain('- CONFIG_NOT_FOUND during config: no e2e.config.ts found');
    expect(text).toContain('No test failed.');
  });
});
