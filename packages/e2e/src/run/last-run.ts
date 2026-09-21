/** What `--last-failed` reads back from the previous run's report. */

import { readFile } from 'node:fs/promises';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { Report1Document } from '../report/build.ts';

type ReportResult = Report1Document['run']['results'][number];

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

function noLastRun(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError('NO_LAST_RUN', message, cause === undefined ? {} : { cause });
}

/**
 * The result ids of the previous run's tests that did not pass, read from the
 * report the run before wrote where this run will write its own: failed,
 * timed out, interrupted, or skipped because a setup, a serial predecessor,
 * a hook, or the worker failed. An explicit skip and a filtered test passed
 * in the sense that matters here: nothing to run again. The ids are
 * `resultId(testId, target, agent)`, so a test is named per target and agent
 * whichever of its `--repeat-each` runs did not pass. A missing or unreadable
 * report is `NO_LAST_RUN`.
 */
export async function readLastFailed(reportPath: string): Promise<ReadonlySet<string>> {
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
  return new Set(document.run.results.filter(didNotPass).map((result) => resultId(result.testId, result.targetId, result.agent)));
}

/**
 * The shape the read relies on: a report-1 envelope whose every result has
 * the fields read here. A hand-edited or truncated file that lacks them is
 * not a report, rather than a crash on the first bad entry.
 */
function isReport(value: unknown): value is Report1Document {
  if (typeof value !== 'object' || value === null) return false;
  const document = value as { schemaVersion?: unknown; run?: { results?: unknown } };
  return document.schemaVersion === 'report-1' && Array.isArray(document.run?.results) && document.run.results.every(isResult);
}

function isResult(value: unknown): value is ReportResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<Record<keyof ReportResult, unknown>>;
  const skip = result.skip as { cause?: unknown } | undefined;
  return (
    typeof result.id === 'string' &&
    typeof result.status === 'string' &&
    (skip === undefined || (typeof skip === 'object' && skip !== null && typeof skip.cause === 'string'))
  );
}
