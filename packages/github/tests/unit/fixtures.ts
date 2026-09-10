/**
 * Report documents for the tests, grown from the runner's own valid report-1
 * fixture so every document here has the shape a real run writes. Results and
 * attempts are built from a few inputs; everything else is the fixture's.
 */

import { readFileSync } from 'node:fs';
import type { FinishedRun, Report } from '@e2edev/e2e';

type ReportRun = Report['run'];
type ReportResult = ReportRun['results'][number];
type ReportAttempt = ReportResult['attempts'][number];
type ReportError = ReportRun['errors'][number];
type ReportTarget = ReportRun['targets'][number];
type ReportSerialGroup = ReportRun['serialGroups'][number];
type ArtifactKind = ReportAttempt['artifacts'][number]['kind'];

const VALID = JSON.parse(
  readFileSync(new URL('../../../e2e/schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8'),
) as Report;
const BASE_RESULT = VALID.run.results[0] as ReportResult;
const BASE_ATTEMPT = BASE_RESULT.attempts[0] as ReportAttempt;
const BASE_TARGET = VALID.run.targets[0] as ReportTarget;

export function attempt(
  input: {
    readonly status?: ReportAttempt['status'];
    readonly durationMs?: number;
    readonly error?: Partial<ReportError> & Pick<ReportError, 'code' | 'message'>;
    readonly artifacts?: readonly ArtifactKind[];
  } = {},
): ReportAttempt {
  return {
    ...BASE_ATTEMPT,
    status: input.status ?? 'passed',
    durationMs: input.durationMs ?? 1200,
    artifacts: (input.artifacts ?? []).map((kind, index) => ({
      ...BASE_ATTEMPT.artifacts[0]!,
      id: `${BASE_ATTEMPT.id}:artifact:${index}`,
      kind,
    })),
    ...(input.error === undefined ? {} : { error: { category: 'test', retryable: false, ...input.error } }),
  };
}

export function result(input: {
  readonly title: string | readonly string[];
  readonly file?: string;
  readonly line?: number;
  readonly target?: string;
  readonly status: ReportResult['status'];
  readonly attempts?: readonly ReportAttempt[];
  readonly skip?: ReportResult['skip'];
  readonly serialGroupId?: string;
}): ReportResult {
  const titlePath = typeof input.title === 'string' ? [input.title] : [...input.title];
  const file = input.file ?? 'tests/example.e2e.ts';
  return {
    ...BASE_RESULT,
    testId: `${file}::${encodeURIComponent(titlePath.join('/'))}`,
    titlePath,
    file,
    source: { file, line: input.line ?? 3, column: 1 },
    targetId: input.target ?? 'web',
    status: input.status,
    attempts: input.attempts ?? [],
    ...(input.skip === undefined ? {} : { skip: input.skip }),
    ...(input.serialGroupId === undefined ? {} : { serialGroupId: input.serialGroupId }),
  };
}

export function report(
  input: {
    readonly status?: ReportRun['status'];
    readonly finishedAt?: string;
    readonly results?: readonly ReportResult[];
    readonly errors?: readonly ReportError[];
    readonly serialGroups?: readonly ReportSerialGroup[];
    readonly targets?: readonly string[];
    readonly projectId?: string;
  } = {},
): Report {
  const status = input.status ?? 'passed';
  const results = input.results ?? [];
  return {
    schemaVersion: 'report-1',
    run: {
      ...VALID.run,
      runner: { name: 'e2e', version: '0.9.0' },
      status,
      exitCode: status === 'passed' ? 0 : 1,
      startedAt: '2026-07-24T12:00:00.000Z',
      finishedAt: input.finishedAt ?? '2026-07-24T12:00:08.400Z',
      project: { ...VALID.run.project, id: input.projectId ?? 'dev.example.shop' },
      targets: (input.targets ?? ['web']).map((id, index) => ({ ...BASE_TARGET, id, index })),
      serialGroups: input.serialGroups ?? [],
      results,
      errors: input.errors ?? [],
    },
  };
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
