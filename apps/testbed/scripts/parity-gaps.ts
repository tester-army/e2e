/**
 * The committed state of the parity suite: one line per Playwright test e2e
 * fails on purpose or by a known gap, each with the reason. A run fails on a
 * failure the file does not list, on a listed test that passes (the gap
 * closed: delete its line), and on a listed test that no longer fails because
 * it was skipped, renamed, or removed. `E2E_PARITY_UPDATE=1` rewrites the file
 * from the run, keeping every surviving reason and marking new lines `TODO`,
 * which fails until someone writes the reason.
 *
 * Line format: `file > describe > test [target] | reason`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export const TODO_REASON = 'TODO: say why e2e differs here, or fix it';

const SEPARATOR = ' | ';

/** The fields of one `report.json` result the check reads. */
export interface ParityResult {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly targetId: string;
  readonly status: string;
  readonly selected: boolean;
}

/** What a run shows against the file. */
export interface ParityDiff {
  /** Failed, timed out, or interrupted, and not listed. */
  readonly unexpected: string[];
  /** Listed, and passed. */
  readonly closed: string[];
  /** Listed, in a file and target that ran, but skipped or gone. */
  readonly stale: string[];
  /** Listed with the `TODO` reason. */
  readonly todo: string[];
}

const FAILING = new Set(['failed', 'timed-out', 'interrupted']);
const PASSING = new Set(['passed', 'flaky']);

/** The key of one result: its file under the tests folder, title path, and target. */
export function keyOf(result: Pick<ParityResult, 'file' | 'titlePath' | 'targetId'>): string {
  const file = result.file.replace(/^tests-parity\//, '');
  return `${[file, ...result.titlePath].join(' > ')} [${result.targetId}]`.replaceAll('\n', ' ');
}

/** The file and target a key belongs to, the unit a run either covers or not. */
function scopeOf(key: string): string {
  return `${key.slice(0, key.indexOf(' > '))} ${key.slice(key.lastIndexOf(' ['))}`;
}

/** Every listed key with its reason; comment and blank lines are skipped. */
export function readGaps(file: string): Map<string, string> {
  const gaps = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cut = line.indexOf(`]${SEPARATOR}`) + 1;
    if (cut === 0) throw new Error(`expected-gaps line has no "[target] | reason": ${line}`);
    gaps.set(line.slice(0, cut), line.slice(cut + SEPARATOR.length));
  }
  return gaps;
}

/**
 * Compares the listed gaps with a run. Only selected results count, and a
 * listed key is judged only when its file and target ran, so a run narrowed
 * by file or `--grep` leaves the other lines alone.
 */
export function diffGaps(gaps: ReadonlyMap<string, string>, results: readonly ParityResult[]): ParityDiff {
  const selected = results.filter((result) => result.selected);
  const scopes = new Set(selected.map((result) => scopeOf(keyOf(result))));
  const byKey = new Map(results.map((result) => [keyOf(result), result]));
  const unexpected: string[] = [];
  const closed: string[] = [];
  const stale: string[] = [];
  for (const result of selected) {
    const key = keyOf(result);
    if (FAILING.has(result.status) && !gaps.has(key)) unexpected.push(key);
  }
  for (const key of gaps.keys()) {
    if (!scopes.has(scopeOf(key))) continue;
    const result = byKey.get(key);
    if (result === undefined) stale.push(key);
    else if (!result.selected) continue;
    else if (PASSING.has(result.status)) closed.push(key);
    else if (!FAILING.has(result.status)) stale.push(key);
  }
  const todo = [...gaps].filter(([, reason]) => reason === TODO_REASON).map(([key]) => key);
  return { unexpected: unexpected.toSorted(), closed: closed.toSorted(), stale: stale.toSorted(), todo: todo.toSorted() };
}

/**
 * Rewrites the file from a run: lines of files and targets that did not run,
 * and of tests the run did not select, stay as they are; the rest become the
 * run's failures, keeping known reasons and marking new ones `TODO`.
 */
export function writeGaps(file: string, header: string, gaps: ReadonlyMap<string, string>, results: readonly ParityResult[]): void {
  const selected = results.filter((result) => result.selected);
  const scopes = new Set(selected.map((result) => scopeOf(keyOf(result))));
  const byKey = new Map(results.map((result) => [keyOf(result), result]));
  const lines = new Map<string, string>();
  for (const [key, reason] of gaps) {
    if (!scopes.has(scopeOf(key)) || byKey.get(key)?.selected === false) lines.set(key, reason);
  }
  for (const result of selected) {
    const key = keyOf(result);
    if (FAILING.has(result.status)) lines.set(key, gaps.get(key) ?? TODO_REASON);
  }
  const body = [...lines].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, reason]) => `${key}${SEPARATOR}${reason}`);
  writeFileSync(file, `${header}\n${body.join('\n')}\n`);
}
