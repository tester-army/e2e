/** What `--last-failed` reads back from the previous run's report. */

import { readFile } from 'node:fs/promises';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { Report1Document } from '../report/build.ts';

type ReportResult = Report1Document['run']['results'][number];
type ReportError = Report1Document['run']['errors'][number];
type ReportSerialGroup = Report1Document['run']['serialGroups'][number];
type ReportCarried = NonNullable<Report1Document['run']['carried']>;

/** Skips that stand for a test the run could not carry out, as opposed to one it chose not to. */
const UNDELIVERED_SKIPS = new Set<NonNullable<ReportResult['skip']>['cause']>([
  'setup-failed',
  'serial-predecessor-failed',
  'hook-failed',
  'infrastructure-unavailable',
  'failure-limit',
]);

/** The id `--last-failed` names a result by: its test, target, and agent, whichever its repeat. */
function rerunId(result: ReportResult): string {
  return resultId(result.testId, result.targetId, result.agent);
}

/** Whether a run error is a failed `beforeAll` or `afterAll`, the failures `--last-failed` runs the scope of again. */
function isSuiteHookFailure(error: ReportError): boolean {
  return error.phase === 'beforeAll' || error.phase === 'afterAll';
}

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
 * interrupted, or skipped because a setup, a serial predecessor, a hook, the
 * worker, or the failure limit stopped it, every selected test in the scope
 * of a `beforeAll` or `afterAll` that failed, until a run where that hook
 * passes, and every test the report carries from an earlier run that it did
 * not run again. A report older than `selected` counts every result as
 * selected. An explicit skip and a filtered test passed in the sense that
 * matters here: nothing to run again. The ids are
 * `resultId(testId, target, agent)`, so a test is named per target and agent
 * whichever of its `--repeat-each` runs did not pass.
 */
export function lastFailedIds(document: Report1Document): ReadonlySet<string> {
  const hookFailures = document.run.errors.filter(isSuiteHookFailure);
  const rerun = (result: ReportResult): boolean =>
    didNotPass(result) || (result.selected !== false && hookFailures.some((error) => inHookScope(result, error)));
  const ids = new Set(document.run.results.filter(rerun).map(rerunId));
  for (const result of document.run.carried?.results ?? []) ids.add(rerunId(result));
  return ids;
}

/** Whether two suite hook failures are the same hook's: one phase, one scope. */
function sameHook(a: ReportError, b: ReportError): boolean {
  if (a.phase !== b.phase) return false;
  if (a.scope === undefined || b.scope === undefined) return a.scope === b.scope;
  return (
    a.scope.file === b.scope.file &&
    a.scope.targetId === b.scope.targetId &&
    a.scope.titlePath.length === b.scope.titlePath.length &&
    a.scope.titlePath.every((title, index) => b.scope!.titlePath[index] === title)
  );
}

/**
 * What a `--last-failed` rerun carries forward from the report it selected
 * from: every result that report owed a rerun and this run did not run, as
 * the run that last ran it reported it; the serial groups those results'
 * attempts live on; and the suite hook failures whose scope still holds one
 * of them. A result is owed when it did not pass, or when it is in the scope
 * of a failed `beforeAll` or `afterAll` this run did not see pass: a hook
 * whose scope this run ran again without it failing is resolved, and one
 * that failed again is this run's own error, which still makes its left-out
 * tests owed. A test this run did not run is one another filter left out
 * (its unselected row) or one on a target or agent this run did not select
 * (no row, though the test and the target are still there); a test the run
 * no longer has cannot run again and is dropped. A test this run selected is
 * no longer carried, whatever its outcome: its own result says it now.
 * Undefined when nothing is carried.
 */
export function carryForward(lastRun: Report1Document, current: Report1Document): ReportCarried | undefined {
  const selected = new Set(current.run.results.filter((result) => result.selected !== false).map(rerunId));
  const present = new Set(current.run.results.map(rerunId));
  const tests = new Set(current.run.results.map((result) => result.testId));
  const targets = new Set(current.run.targets.map((target) => target.id));
  const notRun = (result: ReportResult): boolean => {
    const id = rerunId(result);
    if (selected.has(id)) return false;
    return present.has(id) || (tests.has(result.testId) && targets.has(result.targetId));
  };

  const failedAgain = current.run.errors.filter(isSuiteHookFailure);
  const hooks = [...lastRun.run.errors.filter(isSuiteHookFailure), ...(lastRun.run.carried?.errors ?? [])];
  const reportedAgain = (error: ReportError): boolean => failedAgain.some((again) => sameHook(again, error));
  const passedAgain = (error: ReportError): boolean =>
    !reportedAgain(error) &&
    current.run.results.some((result) => result.selected !== false && result.status !== 'skipped' && inHookScope(result, error));
  const unresolved = hooks.filter((error) => !passedAgain(error));

  // A test the run before left out is known by the row it carried, not by its filtered one.
  const history = [...lastRun.run.results.filter((result) => result.selected !== false), ...(lastRun.run.carried?.results ?? [])];
  const results = history.filter(
    (result) => notRun(result) && (didNotPass(result) || unresolved.some((error) => inHookScope(result, error))),
  );
  if (results.length === 0) return undefined;

  const groupIds = new Set(results.flatMap((result) => (result.serialGroupId === undefined ? [] : [result.serialGroupId])));
  const currentGroupIds = new Set(current.run.serialGroups.map((group) => group.id));
  const serialGroups: ReportSerialGroup[] = [...lastRun.run.serialGroups, ...(lastRun.run.carried?.serialGroups ?? [])].filter(
    (group) => groupIds.has(group.id) && !currentGroupIds.has(group.id),
  );
  const errors = unresolved.filter((error) => !reportedAgain(error) && results.some((result) => inHookScope(result, error)));
  return { results, serialGroups, errors };
}

/**
 * The artifact paths a report names, relative to the artifacts root: every
 * attempt's of its results and serial groups, and of what it carries. What a
 * `--last-failed` rerun keeps of the tree when it starts.
 */
export function reportArtifactPaths(document: Report1Document): ReadonlySet<string> {
  const parts = [document.run, ...(document.run.carried === undefined ? [] : [document.run.carried])];
  const attempts = parts.flatMap((part) => [
    ...part.results.flatMap((result) => result.attempts),
    ...part.serialGroups.flatMap((group) => group.attempts),
  ]);
  return new Set(attempts.flatMap((attempt) => attempt.artifacts.flatMap((artifact) => (artifact.path === undefined ? [] : [artifact.path]))));
}

/**
 * The shape the read relies on: a report-1 envelope whose every result has
 * the fields read here. A hand-edited or truncated file that lacks them is
 * not a report, rather than a crash on the first bad entry.
 */
function isReport(value: unknown): value is Report1Document {
  if (typeof value !== 'object' || value === null) return false;
  const document = value as { schemaVersion?: unknown; run?: { carried?: unknown } };
  return (
    document.schemaVersion === 'report-1' &&
    isRunPart(document.run) &&
    (document.run.carried === undefined || isRunPart(document.run.carried))
  );
}

/** A run, or what one carries: results and errors of the shape read here, and its serial groups. */
function isRunPart(value: unknown): value is { results: ReportResult[]; errors: ReportError[]; serialGroups: unknown[] } {
  if (typeof value !== 'object' || value === null) return false;
  const part = value as { results?: unknown; errors?: unknown; serialGroups?: unknown };
  return (
    Array.isArray(part.results) &&
    part.results.every(isResult) &&
    Array.isArray(part.errors) &&
    part.errors.every(isError) &&
    Array.isArray(part.serialGroups) &&
    part.serialGroups.every((group) => typeof group === 'object' && group !== null && hasAttempts(group))
  );
}

/** Whether a result or serial group lists its attempts, each with its artifacts, the way a rerun reads them. */
function hasAttempts(value: object): boolean {
  const { attempts } = value as { attempts?: unknown };
  return (
    Array.isArray(attempts) &&
    attempts.every((attempt) => typeof attempt === 'object' && attempt !== null && Array.isArray((attempt as { artifacts?: unknown }).artifacts))
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
    hasAttempts(result) &&
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
