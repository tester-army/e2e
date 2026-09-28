/** What `--last-failed` reads back from the previous run's report. */

import { readFile } from 'node:fs/promises';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { Report1Document } from '../report/build.ts';

type ReportResult = Report1Document['run']['results'][number];
type ReportError = Report1Document['run']['errors'][number];

/** Skips that stand for a test the run could not carry out, as opposed to one it chose not to. */
const UNDELIVERED_SKIPS = new Set<NonNullable<ReportResult['skip']>['cause']>([
  'setup-failed',
  'serial-predecessor-failed',
  'hook-failed',
  'infrastructure-unavailable',
]);

/** Whether a result is one `--last-failed` runs again: it did not pass, or the run never got to it. */
function didNotPass(result: ReportResult): boolean {
  switch (result.status) {
    case 'failed':
    case 'timed-out':
    case 'interrupted':
      return true;
    case 'skipped':
      return result.skip !== undefined && UNDELIVERED_SKIPS.has(result.skip.cause);
    default:
      return false;
  }
}

/**
 * Whether a failed suite hook covered a result: same file and target, and
 * declared inside the hook's describe. A hook failure is a run error no
 * result carries, so a test whose body passed there still has to run again.
 * An error that names no scope covers every test, since nothing narrower is
 * known to be safe.
 */
function inHookScope(result: ReportResult, error: ReportError): boolean {
  const scope = error.scope;
  if (scope === undefined) return true;
  return (
    result.file === scope.file &&
    result.targetId === scope.targetId &&
    result.titlePath.length > scope.titlePath.length &&
    scope.titlePath.every((title, index) => result.titlePath[index] === title)
  );
}

function noLastRun(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError('NO_LAST_RUN', message, cause === undefined ? {} : { cause });
}

/**
 * The previous run's report, read from where this run will write its own. It
 * is what `--last-failed` selects from, and reporters receive it as
 * `FinishedRun.lastRun` so one can fold the rerun into it. A missing or
 * unreadable report is `NO_LAST_RUN`.
 */
export async function readLastRun(reportPath: string): Promise<Report1Document> {
  let text: string;
  try {
    text = await readFile(reportPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw noLastRun(`--last-failed needs the report of a previous run, and none is at ${reportPath}; run once without the flag first`);
    }
    throw noLastRun(`--last-failed could not read the previous run's report at ${reportPath}: ${errorMessage(cause)}`, cause);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw noLastRun(`--last-failed found no report in ${reportPath}: ${errorMessage(cause)}`, cause);
  }
  if (!isReport(document)) {
    throw noLastRun(`--last-failed needs a report-1 document at ${reportPath}, which holds something else; run once without the flag to write one`);
  }
  return document;
}

/**
 * The result ids of a report's tests that did not pass: failed, timed out,
 * interrupted, or skipped because a setup, a serial predecessor, a hook, or
 * the worker failed, and every selected test in the scope of a `beforeAll` or
 * `afterAll` that failed, until a run where that hook passes. An explicit
 * skip and a filtered test passed in the sense that matters here: nothing to
 * run again. The ids are `resultId(testId, target, agent)`, so a test is
 * named per target and agent whichever of its `--repeat-each` runs did not
 * pass.
 */
export function lastFailedIds(document: Report1Document): ReadonlySet<string> {
  const hookFailures = document.run.errors.filter((error) => error.phase === 'beforeAll' || error.phase === 'afterAll');
  const rerun = (result: ReportResult): boolean =>
    didNotPass(result) || (result.selected && hookFailures.some((error) => inHookScope(result, error)));
  return new Set(document.run.results.filter(rerun).map((result) => resultId(result.testId, result.targetId, result.agent)));
}

/**
 * The shape the read relies on: a report-1 envelope whose every result has
 * the fields read here. A hand-edited or truncated file that lacks them is
 * not a report, rather than a crash on the first bad entry.
 */
function isReport(value: unknown): value is Report1Document {
  if (typeof value !== 'object' || value === null) return false;
  const document = value as { schemaVersion?: unknown; run?: { results?: unknown; errors?: unknown } };
  return (
    document.schemaVersion === 'report-1' &&
    Array.isArray(document.run?.results) &&
    document.run.results.every(isResult) &&
    Array.isArray(document.run.errors) &&
    document.run.errors.every(isError)
  );
}

function isResult(value: unknown): value is ReportResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<Record<keyof ReportResult, unknown>>;
  const skip = result.skip as { cause?: unknown } | undefined;
  return (
    typeof result.id === 'string' &&
    typeof result.status === 'string' &&
    typeof result.file === 'string' &&
    Array.isArray(result.titlePath) &&
    (skip === undefined || (typeof skip === 'object' && skip !== null && typeof skip.cause === 'string'))
  );
}

function isError(value: unknown): value is ReportError {
  if (typeof value !== 'object' || value === null) return false;
  const { phase, scope } = value as { phase?: unknown; scope?: { file?: unknown; targetId?: unknown; titlePath?: unknown } | null };
  return (
    (phase === undefined || typeof phase === 'string') &&
    (scope === undefined ||
      (typeof scope === 'object' &&
        scope !== null &&
        typeof scope.file === 'string' &&
        typeof scope.targetId === 'string' &&
        Array.isArray(scope.titlePath)))
  );
}
