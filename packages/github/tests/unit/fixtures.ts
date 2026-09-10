/** Report documents for the comment and reporter tests: loose shapes cast to `Report`. */

import type { FinishedRun, Report } from '@e2edev/e2e';

const RUN_ID = '0192c5f0-1234-7abc-8def-0123456789ab';

interface ResultInput {
  readonly title: string | readonly string[];
  readonly file?: string;
  readonly line?: number;
  readonly target?: string;
  readonly status: 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  readonly attempts?: readonly Record<string, unknown>[];
  readonly skip?: { cause: string; reason: string };
  readonly serialGroupId?: string;
}

export function result(input: ResultInput): Record<string, unknown> {
  const titlePath = typeof input.title === 'string' ? [input.title] : [...input.title];
  const file = input.file ?? 'tests/example.e2e.ts';
  return {
    id: 'r'.repeat(64),
    testId: `${file}::${titlePath.join('/')}`,
    kind: 'test',
    declarationIndex: 0,
    titlePath,
    file,
    source: { file, line: input.line ?? 3, column: 1 },
    targetId: input.target ?? 'web',
    platform: 'web',
    status: input.status,
    ...(input.skip === undefined ? {} : { skip: input.skip }),
    ...(input.serialGroupId === undefined ? {} : { serialGroupId: input.serialGroupId }),
    attempts: input.attempts ?? [],
  };
}

export function attempt(input: {
  readonly status?: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  readonly durationMs?: number;
  readonly error?: { code: string; message: string; category?: string; phase?: string };
  readonly artifacts?: readonly string[];
}): Record<string, unknown> {
  return {
    id: RUN_ID,
    index: 0,
    status: input.status ?? 'passed',
    startedAt: '2026-07-24T12:00:00.000Z',
    durationMs: input.durationMs ?? 1200,
    steps: [],
    artifacts: (input.artifacts ?? []).map((kind) => ({
      kind,
      mediaType: 'application/octet-stream',
      redaction: 'complete',
      producer: { kind: 'attempt' },
    })),
    ...(input.error === undefined ? {} : { error: { category: 'test', retryable: false, ...input.error } }),
    secondaryErrors: [],
    cleanup: 'complete',
  };
}

export function report(
  input: {
    readonly status?: 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';
    readonly results?: readonly Record<string, unknown>[];
    readonly errors?: readonly Record<string, unknown>[];
    readonly serialGroups?: readonly Record<string, unknown>[];
    readonly targets?: readonly string[];
    readonly projectId?: string;
  } = {},
): Report {
  const results = input.results ?? [];
  return {
    schemaVersion: 'report-1',
    run: {
      id: RUN_ID,
      specVersion: '0.1',
      runner: { name: 'e2e', version: '0.9.0' },
      status: input.status ?? 'passed',
      exitCode: input.status === undefined || input.status === 'passed' ? 0 : 1,
      startedAt: '2026-07-24T12:00:00.000Z',
      finishedAt: '2026-07-24T12:00:08.400Z',
      project: { id: input.projectId ?? 'dev.example.shop', configDigest: '0'.repeat(64) },
      environment: { ci: true, trustNoticeShown: true, os: 'linux', arch: 'x64', runtime: 'node-26.4.0' },
      targets: (input.targets ?? ['web']).map((id, index) => ({ id, index, platform: 'web' })),
      serialGroups: input.serialGroups ?? [],
      results,
      errors: input.errors ?? [],
      summary: {
        discovered: results.length,
        selected: results.length,
        executed: results.length,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
      },
    },
  } as unknown as Report;
}

export function finished(document: Report): FinishedRun {
  return {
    report: document,
    status: document.run.status,
    exitCode: document.run.exitCode,
    projectRoot: '/work/app',
    reportPath: '/work/app/.e2e/report.json',
    artifactsRoot: '/work/app/.e2e/artifacts',
    aiTracePath: undefined,
  };
}
