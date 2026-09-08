/**
 * One hand-built report-1 document with everything the telemetry builder
 * reads: two targets (one first-party engine, one a project's own), a result
 * whose attempt mixes agent, locator, and assertion steps with cache, model,
 * vision, and error detail, a serial group with a member step, and a run-level
 * error. The strings a project would recognize — the title, the file, the
 * origin, the engine, the messages — are deliberately distinctive so a test can
 * prove none of them reaches a payload.
 */

import type { ResolvedLimits } from '../../src/config/agent.ts';
import { ENGINE_SPI_VERSION } from '../../src/engine/contract.ts';
import type { Report1Document, ReportError, ReportStep } from '../../src/report/build.ts';

const SOURCE = { file: 'tests/secret.e2e.ts', line: 12, column: 3 };

function step(index: number, overrides: Partial<ReportStep> & Pick<ReportStep, 'kind' | 'api'>): ReportStep {
  return {
    id: `step-${index}`,
    index,
    label: `Secret step label ${index}`,
    source: SOURCE,
    status: 'passed',
    startedAt: '2026-09-08T10:00:00.000Z',
    durationMs: 100,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

const testError: ReportError = {
  category: 'test',
  code: 'LOCATOR_NOT_FOUND',
  message: 'boom message with http://acme.example/secret',
  retryable: false,
  phase: 'body',
};

const LIMITS: ResolvedLimits = {
  maxAgentContextBytes: 1,
  maxLedgerBytes: 1,
  maxObservationBytes: 1,
  maxEventsPerStep: 1,
  maxModelTokensPerCall: 1,
};

export function sampleReport(): Report1Document {
  return {
    schemaVersion: 'report-1',
    run: {
      id: '0192f3a0-0000-7000-8000-000000000000',
      specVersion: '0.1',
      runner: { name: 'e2e', version: '1.2.3' },
      status: 'failed',
      exitCode: 1,
      startedAt: '2026-09-08T10:00:00.000Z',
      finishedAt: '2026-09-08T10:00:05.000Z',
      project: { id: '@acme/secret-app', configDigest: 'a'.repeat(64) },
      environment: {
        ci: false,
        trustNoticeShown: false,
        os: 'darwin 25.6.0',
        arch: 'arm64',
        runtime: 'node v26.4.0',
      },
      targets: [
        {
          id: 'web',
          index: 0,
          platform: 'web',
          baseOrigin: 'http://acme.example',
          environment: 'local',
          testIdAttribute: 'data-testid',
          engine: { name: 'playwright', version: '0.6.1', spiVersion: ENGINE_SPI_VERSION },
          capabilities: [],
          artifactCapabilities: [],
          stateCapability: false,
        },
        {
          id: 'headset',
          index: 1,
          platform: 'vision-pro',
          environment: 'local',
          testIdAttribute: 'data-testid',
          engine: { name: 'acme-engine', version: '9.9.9', spiVersion: ENGINE_SPI_VERSION },
          capabilities: [],
          artifactCapabilities: [],
          stateCapability: false,
        },
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
          memberTestIds: ['tests/secret.e2e.ts::Secret%20Title::pays'],
          status: 'passed',
          attempts: [
            {
              id: 'serial-attempt-1',
              index: 0,
              status: 'passed',
              startedAt: '2026-09-08T10:00:00.000Z',
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
                  startedAt: '2026-09-08T10:00:00.000Z',
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
        {
          id: 'b'.repeat(64),
          testId: 'tests/secret.e2e.ts::Secret%20Title',
          kind: 'test',
          declarationIndex: 0,
          titlePath: ['Secret Title'],
          file: 'tests/secret.e2e.ts',
          source: SOURCE,
          targetId: 'web',
          platform: 'web',
          status: 'failed',
          attempts: [
            {
              id: 'attempt-1',
              index: 0,
              status: 'failed',
              startedAt: '2026-09-08T10:00:00.000Z',
              durationMs: 4000,
              artifacts: [],
              error: { ...testError, code: 'not-a-runner-code' },
              secondaryErrors: [],
              cleanup: 'complete',
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
                step(2, { kind: 'locator', api: 'locator.tap', status: 'failed', error: testError }),
                step(3, { kind: 'assertion', api: 'expect.toBeVisible' }),
              ],
            },
          ],
        },
      ],
      errors: [
        {
          category: 'infrastructure',
          code: 'APP_UNREACHABLE',
          message: 'nothing listens at http://acme.example',
          retryable: false,
          phase: 'launch',
        },
      ],
      summary: { discovered: 3, selected: 2, executed: 2, passed: 1, failed: 1, flaky: 0, skipped: 1 },
      limits: LIMITS,
      usage: {
        discoveredResults: 3,
        maxAgentContextBytes: 1,
        maxLedgerBytes: 1,
        maxObservationBytes: 1,
        artifactBytes: 4096,
        downloads: 0,
        events: 12,
        modelTokens: 2850,
        maxModelCallsInStep: 3,
        maxActionStepsInStep: 4,
        estimatedCostUsd: 0.01,
      },
    },
  };
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
