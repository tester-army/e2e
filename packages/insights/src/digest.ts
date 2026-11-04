import type { Report } from 'e2e';

type ReportRun = Report['run'];
type ReportResult = ReportRun['results'][number];
type ReportStep = ReportResult['attempts'][number]['steps'][number];
type ReportError = NonNullable<ReportResult['attempts'][number]['error']>;

/** The `schemaVersion` of one history line, pinned by `schema/history-v1.schema.json`. */
export const HISTORY_SCHEMA_VERSION = 'history-1';

/** A test result's final status, as the report spells it. */
export type TestStatus = ReportResult['status'];

/** How the replay cache took part in a test's agent steps, every attempt counted. */
export interface CacheCounts {
  /** Agent steps the cache took part in. */
  steps: number;
  /** Steps whose recording completed with no model call (`self-finalized`). */
  replayed: number;
  /** Steps a replayed prefix handed to the agent (`agent-concluded`). */
  handedOff: number;
  /** Steps the agent ran from the beginning (`missed`). */
  missed: number;
  /** Miss and hand-off reason tokens (`no-entry`, `end-mismatch`, ...) and how often each came up. */
  reasons: Record<string, number>;
}

/** One test result of one run, reduced to what the analysis needs. */
export interface HistoryTest {
  /** The report's `testId`: the key `TestFilterResult.exclude` takes. */
  testId: string;
  targetId: string;
  /** The configured agent the result ran as; one result per agent when a test runs under several. */
  agent: string;
  /** The `--repeat-each` index; 0 for the run every test has. */
  repeat: number;
  titlePath: string[];
  file: string;
  status: TestStatus;
  /** Every attempt's status, first to last. */
  attempts: string[];
  /** Each attempt's error category, parallel to `attempts`; `null` for an attempt with no error. */
  attemptErrors: (string | null)[];
  durationMs: number;
  /** The final attempt's error code, never its message. */
  errorCode?: string;
  /** The final attempt's error category: `test`, `infrastructure`, ... */
  errorCategory?: string;
  modelCalls: number;
  tokens: number;
  costUsd?: number;
  cache: CacheCounts;
}

/** One run as a line of `runs.jsonl`. */
export interface HistoryRun {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  durationMs: number;
  status: ReportRun['status'];
  projectId: string;
  runnerVersion: string;
  ci: boolean;
  vcs?: { commit: string; branch?: string; dirty?: boolean };
  summary: ReportRun['summary'];
  modelTokens: number;
  costUsd?: number;
  tests: HistoryTest[];
}

/**
 * Reduces a report-1 document to one history record. It keeps ids, titles,
 * statuses, timings, counters, and error codes only: no step label, error
 * message, app text, or artifact path, so the history holds nothing the
 * report's redaction would have to cover again. Results the run never
 * executed (left out, skipped, or interrupted before a verdict) are dropped:
 * they say nothing about how a test behaves.
 */
export function digestReport(report: Report): HistoryRun {
  const run = report.run;
  const serialSteps = collectSerialSteps(run);
  const tests: HistoryTest[] = [];
  for (const result of run.results) {
    if (!result.selected || result.status === 'skipped' || result.status === 'interrupted') continue;
    tests.push(digestResult(result, serialSteps));
  }
  const finishedMs = Date.parse(run.finishedAt);
  const startedMs = Date.parse(run.startedAt);
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    runId: run.id,
    startedAt: run.startedAt,
    durationMs: Number.isFinite(finishedMs - startedMs) ? Math.max(0, finishedMs - startedMs) : 0,
    status: run.status,
    projectId: run.project.id,
    runnerVersion: run.runner.version,
    ci: run.environment.ci,
    ...(run.vcs
      ? {
          vcs: {
            commit: run.vcs.commit,
            ...(run.vcs.branch === undefined ? {} : { branch: run.vcs.branch }),
            ...(run.vcs.dirty === undefined ? {} : { dirty: run.vcs.dirty }),
          },
        }
      : {}),
    summary: { ...run.summary },
    modelTokens: run.usage.modelTokens,
    ...(run.usage.estimatedCostUsd === undefined ? {} : { costUsd: run.usage.estimatedCostUsd }),
    tests,
  };
}

/** The steps and statuses of serial group members, which live on the group's attempts, not on the result. */
function collectSerialSteps(run: ReportRun): Map<string, SerialMemberRecord> {
  const byKey = new Map<string, SerialMemberRecord>();
  for (const group of run.serialGroups) {
    for (const attempt of group.attempts) {
      for (const member of attempt.members) {
        const key = serialKey(group.id, member.testId);
        const entry = byKey.get(key) ?? { steps: [], statuses: [], errors: [], durationMs: 0 };
        entry.steps.push(...member.steps);
        entry.statuses.push(member.status);
        // Core reads a member's verdict error the same way: its own, else the group attempt's.
        entry.errors.push(member.error ?? attempt.error);
        entry.durationMs += member.durationMs;
        byKey.set(key, entry);
      }
    }
  }
  return byKey;
}

/** What one serial member did across its group's attempts. */
interface SerialMemberRecord {
  steps: ReportStep[];
  statuses: string[];
  errors: (ReportError | undefined)[];
  durationMs: number;
}

function serialKey(groupId: string, testId: string): string {
  return `${groupId}\u0000${testId}`;
}

function digestResult(result: ReportResult, serialSteps: Map<string, SerialMemberRecord>): HistoryTest {
  const serial =
    result.attempts.length === 0 && result.serialGroupId !== undefined
      ? serialSteps.get(serialKey(result.serialGroupId, result.testId))
      : undefined;
  const steps = serial ? serial.steps : result.attempts.flatMap((attempt) => attempt.steps);
  const attempts = serial ? serial.statuses : result.attempts.map((attempt) => attempt.status);
  const durationMs = serial
    ? serial.durationMs
    : result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
  const errors = serial ? serial.errors : result.attempts.map((attempt) => attempt.error);
  const finalError = errors.at(-1);

  let modelCalls = 0;
  let tokens = 0;
  let costUsd: number | undefined;
  const cache: CacheCounts = { steps: 0, replayed: 0, handedOff: 0, missed: 0, reasons: {} };
  for (const step of steps) {
    modelCalls += step.metrics?.modelCalls ?? 0;
    if (step.model) {
      tokens += step.model.inputTokens + step.model.outputTokens;
      if (step.model.estimatedCostUsd !== undefined) costUsd = (costUsd ?? 0) + step.model.estimatedCostUsd;
    }
    if (step.cache) {
      cache.steps += 1;
      if (step.cache.mode === 'self-finalized') cache.replayed += 1;
      else if (step.cache.mode === 'agent-concluded') cache.handedOff += 1;
      else cache.missed += 1;
      if (step.cache.reason !== undefined) cache.reasons[step.cache.reason] = (cache.reasons[step.cache.reason] ?? 0) + 1;
    }
  }

  return {
    testId: result.testId,
    targetId: result.targetId,
    agent: result.agent,
    repeat: result.repeat,
    titlePath: [...result.titlePath],
    file: result.file,
    status: result.status,
    attempts,
    attemptErrors: errors.map((error) => error?.category ?? null),
    durationMs,
    ...(finalError ? { errorCode: finalError.code, errorCategory: finalError.category } : {}),
    modelCalls,
    tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    cache,
  };
}
