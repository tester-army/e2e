/**
 * The committed state of the cross-check: one line per known disagreement,
 * each with the reason it is kept. A run fails on a disagreement the file
 * does not list and on a listed one that no longer happens, so a fix removes
 * its line and a regression adds one, both in review. `E2E_CROSSCHECK_UPDATE=1`
 * rewrites the file from the run, keeping every surviving reason and marking
 * new lines `TODO`, which fails until someone writes the reason.
 *
 * Line format, fields separated by ` | `:
 *
 *   page | oracle field | role "name" | ours <value> | theirs <value> | reason
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { Disagreement } from './crosscheck.ts';

export const TODO_REASON = 'TODO: say why this disagreement is kept, or fix it';

const SEPARATOR = ' | ';

/** The line of one disagreement without its reason; equal keys are the same disagreement. */
export function keyOf(page: string, disagreement: Disagreement): string {
  return [
    page,
    `${disagreement.oracle} ${disagreement.field}`,
    disagreement.node,
    `ours ${disagreement.ours}`,
    `theirs ${disagreement.theirs}`,
  ].join(SEPARATOR).replaceAll('\n', ' ');
}

/** Every listed key with its reason; comment and blank lines are skipped. */
export function readExpectations(file: string): Map<string, string> {
  const expected = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cut = line.lastIndexOf(SEPARATOR);
    expected.set(line.slice(0, cut), line.slice(cut + SEPARATOR.length));
  }
  return expected;
}

/** Expected keys of the pages that ran which did not happen, and seen keys the file does not list. */
export function diffExpectations(
  expected: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
  pages: ReadonlySet<string>,
): { unexpected: string[]; stale: string[] } {
  const pageOf = (key: string) => key.slice(0, key.indexOf(SEPARATOR));
  return {
    unexpected: [...seen].filter((key) => !expected.has(key)).toSorted(),
    stale: [...expected.keys()].filter((key) => pages.has(pageOf(key)) && !seen.has(key)).toSorted(),
  };
}

/**
 * Rewrites the file: lines of pages that did not run are kept as they are,
 * lines of pages that ran are replaced by what they showed.
 */
export function writeExpectations(
  file: string,
  header: string,
  expected: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
  pages: ReadonlySet<string>,
): void {
  const pageOf = (key: string) => key.slice(0, key.indexOf(SEPARATOR));
  const lines = new Map<string, string>();
  for (const [key, reason] of expected) if (!pages.has(pageOf(key))) lines.set(key, reason);
  for (const key of seen) lines.set(key, expected.get(key) ?? TODO_REASON);
  const body = [...lines].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, reason]) => `${key}${SEPARATOR}${reason}`);
  writeFileSync(file, `${header}\n${body.join('\n')}\n`);
}
