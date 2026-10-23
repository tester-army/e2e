/**
 * Whether a run's test filters are called: the one gate `run` and `list`
 * share. A `--last-failed` rerun's tests are owed and never judged, and
 * without a change since the merge base there is nothing to judge.
 * Otherwise every filter judges every test the selection runs.
 */

import type { ReportChanges } from '../report/build.ts';
import { shortCommit } from '../report/format.ts';
import { plural } from '../report/markdown-text.ts';
import type { TestFilterCandidate, TestFilterChanges } from '../types.ts';
import { findChanges } from './changes.ts';

/** What the gate decides from. */
export interface FilterGateInput {
  /** The tests the selection runs, as the filters would be handed them. */
  readonly candidates: readonly TestFilterCandidate[];
  /** Whether this is a `--last-failed` rerun, whose tests are owed. */
  readonly lastFailed: boolean;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string;
  /** The project root, spelled as on disk as `changes.root` is. */
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  /** One line about what the gate decided. */
  readonly notice: (message: string) => void;
}

/** The gate's decision, with what `run.changes` records: no filter is called, or the filters judge on `changes`. */
export type FilterGate =
  | { readonly kind: 'skip'; readonly record: ReportChanges }
  | { readonly kind: 'judge'; readonly changes: TestFilterChanges; readonly record: ReportChanges };

/**
 * Decides whether the filters are called: never on a `--last-failed`
 * rerun, nor with no test to judge (git is asked for neither), nor without
 * a change. Each decision is one notice.
 */
export async function gateTestFilters(input: FilterGateInput): Promise<FilterGate> {
  /** No filter is called, for `record.skipped`, said as `message` or `<why>, so no filter ran`. */
  const skip = (record: ReportChanges & { readonly skipped: string }, message = `${record.skipped}, so no filter ran`): FilterGate => {
    input.notice(message);
    return { kind: 'skip', record };
  };
  if (input.lastFailed) return skip({ skipped: '--last-failed' }, '--last-failed: the tests the last run owes run without filters');
  if (input.candidates.length === 0) return skip({ skipped: 'no tests to judge' });
  const lookup = await findChanges({ cwd: input.projectRoot, changedSince: input.changedSince, signal: input.signal });
  if (lookup.kind === 'none') return skip({ base: lookup.base, files: 0, skipped: lookup.reason });
  const { changes } = lookup;
  input.notice(`judging ${plural(changes.files.length, 'file')} changed since ${shortCommit(changes.base)}`);
  return { kind: 'judge', changes, record: { base: changes.base, files: changes.files.length } };
}
