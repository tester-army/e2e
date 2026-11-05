import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_SCHEMA_VERSION, type HistoryRun } from './digest.ts';

/** The history file's name inside the history directory. */
export const HISTORY_FILE = 'runs.jsonl';

/** What reading one or more history files produced. */
export interface LoadedHistory {
  /** Runs oldest first, one per run id. */
  runs: HistoryRun[];
  /** Lines that were not a history-1 record: a torn write, a newer schema, hand edits. */
  skippedLines: number;
}

interface ParsedHistory extends LoadedHistory {
  /** Lines of another `schemaVersion`, such as a newer package's, kept verbatim when the file is trimmed. */
  foreignLines: string[];
}

/**
 * Parses JSONL text into history runs. A line that is not JSON, or whose
 * `schemaVersion` is not `history-1`, is counted and skipped rather than
 * failing the read: one torn append must not cost the rest of the history.
 */
function parseHistory(text: string): ParsedHistory {
  const runs: HistoryRun[] = [];
  const foreignLines: string[] = [];
  let skippedLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (isHistoryRun(value)) {
      runs.push(value);
      continue;
    }
    skippedLines += 1;
    if (isForeign(value)) foreignLines.push(line);
  }
  return { runs, skippedLines, foreignLines };
}

/** A JSON object of another schema version: a record this version cannot read but must not destroy. */
function isForeign(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const version = (value as Record<string, unknown>)['schemaVersion'];
  return typeof version === 'string' && version !== HISTORY_SCHEMA_VERSION;
}

/**
 * Whether a parsed line is a history-1 record. It checks the fields every
 * reader dereferences; the rest is the reporter's own output, and
 * `schema/history-v1.schema.json` pins it in the tests.
 */
function isHistoryRun(value: unknown): value is HistoryRun {
  if (value === null || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  return (
    run['schemaVersion'] === HISTORY_SCHEMA_VERSION &&
    typeof run['runId'] === 'string' &&
    typeof run['startedAt'] === 'string' &&
    typeof run['status'] === 'string' &&
    typeof run['modelTokens'] === 'number' &&
    optionalNumber(run['costUsd']) &&
    Array.isArray(run['tests']) &&
    run['tests'].every(isHistoryTest)
  );
}

function isHistoryTest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const test = value as Record<string, unknown>;
  const cache = test['cache'] as Record<string, unknown> | null | undefined;
  return (
    typeof test['testId'] === 'string' &&
    typeof test['targetId'] === 'string' &&
    typeof test['status'] === 'string' &&
    typeof test['file'] === 'string' &&
    Array.isArray(test['titlePath']) &&
    typeof test['durationMs'] === 'number' &&
    typeof test['modelCalls'] === 'number' &&
    typeof test['tokens'] === 'number' &&
    typeof test['agent'] === 'string' &&
    Array.isArray(test['attempts']) &&
    Array.isArray(test['attemptErrors']) &&
    optionalNumber(test['costUsd']) &&
    cache !== null &&
    typeof cache === 'object' &&
    ['steps', 'replayed', 'handedOff', 'missed'].every((key) => typeof cache[key] === 'number') &&
    cache['reasons'] !== null &&
    typeof cache['reasons'] === 'object' &&
    Object.values(cache['reasons']).every((count) => typeof count === 'number')
  );
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Merges runs from several sources (CI jobs, a local file, downloaded
 * artifacts) into one history: one record per run id, the later source
 * winning, sorted oldest first by start time.
 */
function mergeRuns(...sources: readonly (readonly HistoryRun[])[]): HistoryRun[] {
  const byId = new Map<string, HistoryRun>();
  for (const source of sources) for (const run of source) byId.set(run.runId, run);
  return [...byId.values()].toSorted((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
}

/** Reads and merges history files; a file that does not exist reads as empty. */
export async function loadHistory(files: readonly string[]): Promise<LoadedHistory> {
  const loaded: HistoryRun[][] = [];
  let skippedLines = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const parsed = parseHistory(text);
    loaded.push(parsed.runs);
    skippedLines += parsed.skippedLines;
  }
  return { runs: mergeRuns(...loaded), skippedLines };
}

/** Runs past `keep` the file may hold before an append trims it, so most appends never rewrite the file. */
function trimSlack(keep: number): number {
  return Math.max(10, Math.ceil(keep / 4));
}

/**
 * Adds a run to the history file and returns the newest `keep` runs. The run
 * is appended as one line, so two runs finishing at once in one project both
 * land. Once the file holds `keep` plus a slack of runs, it is trimmed to
 * `keep` through a temporary sibling and a rename: a crash mid-trim leaves
 * the previous file whole, lines of another schema version are kept as they
 * are, and only torn lines are dropped.
 */
export async function appendRun(file: string, run: HistoryRun, keep: number): Promise<HistoryRun[]> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(run)}\n`, 'utf8');
  const parsed = parseHistory(await readFile(file, 'utf8'));
  const runs = mergeRuns(parsed.runs);
  if (runs.length > keep + trimSlack(keep)) {
    const kept = runs.slice(-keep);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, [...parsed.foreignLines, ...kept.map((entry) => JSON.stringify(entry))].join('\n') + '\n', 'utf8');
    await rename(temporary, file);
  }
  return runs.slice(-keep);
}
