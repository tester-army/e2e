/**
 * One report-1 document with everything the telemetry builder reads: two
 * targets (one first-party engine, one a project's own), a result whose
 * attempt mixes agent, locator, and assertion steps with cache, model,
 * vision, and error detail, a serial group with a member step, and a
 * run-level error. Every string a project would recognize — the title, the
 * file, the origin, the messages — is deliberately distinctive and listed in
 * SAMPLE_REPORT_SECRETS, so a test can prove none reaches a payload. The
 * engine name and the platform are declared names and reach it as they are.
 */

import { ENGINE_SPI_VERSION } from '../../src/engine/contract.ts';
import type { Report1Document, ReportStep } from '../../src/report/build.ts';
import { reportAttempt, reportDocument, reportError, reportResult, reportStep, reportTarget } from './report.ts';

const SOURCE = { file: 'tests/secret.e2e.ts', line: 12, column: 3 };
const STARTED_AT = '2026-09-08T10:00:00.000Z';

function step(index: number, overrides: Partial<ReportStep> & Pick<ReportStep, 'kind' | 'api'>): ReportStep {
  return reportStep({
    id: `step-${index}`,
    index,
    label: `Secret step label ${index}`,
    source: SOURCE,
    startedAt: STARTED_AT,
    ...overrides,
  });
}

const locatorError = reportError({
  code: 'LOCATOR_NOT_FOUND',
  message: 'boom message with http://acme.example/secret',
  phase: 'body',
});

export function sampleReport(): Report1Document {
  return reportDocument({
    id: '0192f3a0-0000-7000-8000-000000000000',
    runner: { name: 'e2e', version: '1.2.3' },
    status: 'failed',
    exitCode: 1,
    startedAt: STARTED_AT,
    finishedAt: '2026-09-08T10:00:05.000Z',
    project: { id: '@acme/secret-app', configDigest: 'a'.repeat(64) },
    environment: { ci: false, trustNoticeShown: false, os: 'darwin 25.6.0', arch: 'arm64', runtime: 'node v26.4.0' },
    targets: [
      reportTarget({ baseOrigin: 'http://acme.example' }),
      reportTarget({
        id: 'headset',
        index: 1,
        platform: 'vision-pro',
        engine: { name: 'homegrown', version: '9.9.9', spiVersion: ENGINE_SPI_VERSION },
      }),
    ],
    serialGroups: [
      {
        id: 'group-1',
        serialId: 'checkout',
        declarationIndex: 1,
        file: 'tests/secret.e2e.ts',
        source: SOURCE,
        titlePath: ['Secret Title', 'checkout'],
        targetId: 'web',
        platform: 'web',
        agent: 'default',
        memberTestIds: ['tests/secret.e2e.ts::Secret%20Title::pays'],
        status: 'passed',
        attempts: [
          {
            id: 'serial-attempt-1',
            index: 0,
            status: 'passed',
            startedAt: STARTED_AT,
            durationMs: 900,
            artifacts: [],
            secondaryErrors: [],
            cleanup: 'complete',
            members: [
              {
                id: 'member-1',
                index: 0,
                testId: 'tests/secret.e2e.ts::Secret%20Title::pays',
                status: 'passed',
                startedAt: STARTED_AT,
                durationMs: 900,
                steps: [step(0, { kind: 'screen', api: 'screen.getByRole' })],
                secondaryErrors: [],
              },
            ],
          },
        ],
      },
    ],
    results: [
      reportResult({
        id: 'b'.repeat(64),
        testId: 'tests/secret.e2e.ts::Secret%20Title',
        titlePath: ['Secret Title'],
        file: 'tests/secret.e2e.ts',
        source: SOURCE,
        status: 'failed',
        attempts: [
          reportAttempt({
            status: 'failed',
            startedAt: STARTED_AT,
            durationMs: 4000,
            error: { ...locatorError, code: 'not-a-runner-code' },
            steps: [
              step(0, {
                kind: 'agent',
                api: 'agent.act',
                visionInput: true,
                cache: { mode: 'self-finalized', replayedActions: 4, totalActions: 4 },
                model: {
                  provider: 'anthropic',
                  model: 'claude-sonnet-4-5',
                  endpoint: 'https://gateway.acme.example/v1',
                  adapterVersion: '1',
                  policyVersion: '1',
                  calls: 3,
                  tokenAccounting: 'provider',
                  peakTokensPerCall: 1000,
                  inputTokens: 2000,
                  outputTokens: 300,
                  estimatedCostUsd: 0.01,
                },
              }),
              step(1, {
                kind: 'agent',
                api: 'agent.act',
                cache: { mode: 'missed', reason: 'no-entry', replayedActions: 0, totalActions: 0 },
                model: {
                  provider: 'openai',
                  model: 'ft:gpt-4o:acme:custom:abc',
                  endpoint: 'https://api.openai.com/v1',
                  adapterVersion: '1',
                  policyVersion: '1',
                  calls: 1,
                  tokenAccounting: 'provider',
                  peakTokensPerCall: 500,
                  inputTokens: 500,
                  outputTokens: 50,
                },
              }),
              step(2, { kind: 'locator', api: 'locator.tap', status: 'failed', error: locatorError }),
              step(3, { kind: 'assertion', api: 'expect.toBeVisible' }),
            ],
          }),
        ],
      }),
    ],
    errors: [
      reportError({
        category: 'infrastructure',
        code: 'APP_UNREACHABLE',
        message: 'nothing listens at http://acme.example',
        phase: 'launch',
      }),
    ],
    summary: { discovered: 3, selected: 2, executed: 2, passed: 1, failed: 1, flaky: 0, skipped: 1 },
    usage: {
      discoveredResults: 3,
      maxAgentContextBytes: 1,
      maxLedgerBytes: 1,
      maxObservationBytes: 1,
      artifactBytes: 4096,
      files: 0,
      events: 12,
      modelTokens: 2850,
      maxModelCallsInStep: 3,
      maxActionStepsInStep: 4,
      estimatedCostUsd: 0.01,
    },
  });
}

/** Strings from the sample a payload must never carry. */
export const SAMPLE_REPORT_SECRETS: readonly string[] = [
  'Secret',
  'secret.e2e.ts',
  'acme',
  'http://',
  'https://',
  'boom message',
  'nothing listens',
  'checkout',
  'pays',
];
