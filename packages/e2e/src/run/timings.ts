/**
 * The timings history (`<output>/timings.json`, schema `timings-1`): how long
 * each target's file took, kept between runs so the scheduler can start the
 * longest files first even on a fresh CI checkout that restored only this
 * small file from its cache. Advisory by contract: a missing, stale,
 * corrupt, or schema-invalid file is no history, never an error, so a
 * poisoned cache can reorder work and nothing else.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Report1Document } from '../report/build.ts';
import { writeJsonReport } from '../report/write.ts';
import { fileDurationsOf, previousFileDurations } from './last-run.ts';

/** The `schemaVersion` of a timings file. */
const TIMINGS_SCHEMA_VERSION = 'timings-1';

/** Past this a file is not ours to read: a real one holds a few KB per hundred files. */
const MAX_TIMINGS_BYTES = 8 * 1024 * 1024;

/** The weight a run's own time carries against the history before it, so one slow run moves an entry by a third. */
const NEW_RUN_WEIGHT = 1 / 3;

/** The separator `fileDurationKey` puts between a target name and a file; target names never hold a `:`. */
const KEY_SEPARATOR = '::';

/** Reads `timings.json`; undefined for anything but a valid `timings-1` document. */
async function readTimingsFile(file: string): Promise<ReadonlyMap<string, number> | undefined> {
  try {
    if ((await stat(file)).size > MAX_TIMINGS_BYTES) return undefined;
    const document: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
    const { schemaVersion, files, ...rest } = document as Record<string, unknown>;
    if (schemaVersion !== TIMINGS_SCHEMA_VERSION || Object.keys(rest).length > 0) return undefined;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
    const durations = new Map<string, number>();
    for (const [key, ms] of Object.entries(files)) {
      if (!key.includes(KEY_SEPARATOR) || typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) return undefined;
      durations.set(key, ms);
    }
    return durations;
  } catch {
    return undefined;
  }
}

/**
 * The history a run schedules by: the timings file when it is valid, else the
 * previous run's `report.json`, as before the file existed. No history is an
 * empty map.
 */
export async function loadTimings(timingsPath: string, reportPath: string): Promise<ReadonlyMap<string, number>> {
  return (await readTimingsFile(timingsPath)) ?? (await previousFileDurations(reportPath));
}

/**
 * Folds one run's file durations into the history: an entry the run measured
 * moves toward it by an exponential moving average, a new one takes it, and
 * an entry for a target the config no longer has or a file no longer on disk
 * is dropped. A file the run did not reach keeps its old time.
 */
function mergeTimings(
  history: ReadonlyMap<string, number>,
  measured: ReadonlyMap<string, number>,
  keep: (target: string, file: string) => boolean,
): Record<string, number> {
  const merged = new Map(history);
  for (const [key, ms] of measured) {
    const before = history.get(key);
    merged.set(key, before === undefined ? ms : Math.round(before + (ms - before) * NEW_RUN_WEIGHT));
  }
  const files: Record<string, number> = {};
  for (const key of [...merged.keys()].toSorted()) {
    const at = key.indexOf(KEY_SEPARATOR);
    if (at < 0 || !keep(key.slice(0, at), key.slice(at + KEY_SEPARATOR.length))) continue;
    files[key] = Math.round(merged.get(key)!);
  }
  return files;
}

export interface WriteTimingsOptions {
  /** The timings file to read and rewrite. */
  readonly timingsPath: string;
  /** The `report.json` an absent timings file falls back to. */
  readonly reportPath: string;
  /** The project root the report's files are relative to. */
  readonly projectRoot: string;
  /** The names of the config's targets. */
  readonly targets: ReadonlySet<string>;
}

/**
 * Rewrites the timings file from a finished run's report. A run that timed no
 * file leaves the file as it was. The caller treats a failure as a line on
 * stderr: the history is advisory and never changes a run's outcome.
 */
export async function writeTimings(document: Report1Document, options: WriteTimingsOptions): Promise<void> {
  const measured = fileDurationsOf(document);
  if (measured.size === 0) return;
  const history = await loadTimings(options.timingsPath, options.reportPath);
  const files = mergeTimings(
    history,
    measured,
    (target, file) => options.targets.has(target) && existsSync(path.resolve(options.projectRoot, file)),
  );
  await writeJsonReport(options.timingsPath, { schemaVersion: TIMINGS_SCHEMA_VERSION, files });
}
