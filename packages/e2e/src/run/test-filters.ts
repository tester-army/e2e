/** Test filters (`filters`): which apply, what they are given, calling them, and what they decided. */

import path from 'node:path';
import type { Collection } from '../collect/collect.ts';
import { select, type Selection, type SelectionFilters, type TestExclusion, type TestTargetPair } from '../collect/select.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import { describeValue } from '../config/validate.ts';
import { leaveWorkBehind } from '../internal/abandoned.ts';
import { E2EError, errorMessage } from '../internal/errors.ts';
import { isPlainObject } from '../internal/options.ts';
import { onDiskPath } from '../internal/paths.ts';
import { collapseText } from '../internal/text.ts';
import { budgetText, withAbort } from '../internal/time.ts';
import { compareTests, type FilterOutcome, type ReportChanges, type ReportFilter } from '../report/build.ts';
import { ellipsize, filterDecision, shortCommit } from '../report/format.ts';
import { plural } from '../report/markdown-text.ts';
import { leftOutTests } from '../report/left-out.ts';
import type { TestFilter, TestFilterCandidate, TestFilterChanges, TestFilterContext } from '../types.ts';
import { findChanges } from './changes.ts';
import { staticSecretLedger } from './secrecy.ts';

/** What `filterSelection` judges a selection with, and where each line about what the gate and the filters decided goes. */
export interface FilterSelectionOptions {
  readonly config: ResolvedConfig;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string;
  readonly signal: AbortSignal;
  /** One line about what the filters judge and what each decided. */
  readonly notice: (message: string) => void;
  readonly collection: Collection;
  /** The flags the selection was made with, `--last-failed` among them. */
  readonly selectionFilters: SelectionFilters;
  /** How each filter call is wrapped; called bare unless set. */
  readonly step?: TestFilterScope['step'] | undefined;
  /** How long each filter call may take; `FILTER_TIMEOUT_MS` unless set. */
  readonly timeoutMs?: number | undefined;
}

/** A selection once the test filters had their say, the report's record of them, and the change they judged; no change when the config has no filter. */
interface FilteredSelection {
  readonly selection: Selection;
  readonly records: readonly ReportFilter[];
  readonly changes: ReportChanges | undefined;
}

/** One filter's decision: its record before the final selection counts what it left out. */
type FilterDecision = Omit<ReportFilter, 'excluded'>;

/** What `applyTestFilters` hands each filter and where its lines go. */
export interface TestFilterScope {
  readonly projectRoot: string;
  /** The change every filter judges. */
  readonly changes: TestFilterChanges;
  /** The loaded config file relative to `changes.root`, POSIX; none for a config object. */
  readonly configFile: string | undefined;
  readonly secrets: ResolvedConfig['allSecrets'];
  /** The id of every collected test, setup tests included: an `exclude` naming one a filter was not given is ignored, since that test's fate is settled. */
  readonly collectedIds: ReadonlySet<string>;
  /** How long each filter call may take before the run stops waiting for it. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** One line, already prefixed and redacted. */
  readonly notice: (message: string) => void;
  /** `run` wraps each call in the `filter` setup step, which ends `failed` or `timed-out` for a call that did not answer; `list` calls it bare. */
  readonly step: (name: string, work: () => Promise<FilterCall>) => Promise<FilterCall>;
}

/** How one filter call ended: with its answer, checked; or thrown, refused, or abandoned past the deadline, with the note that says so. */
type FilterCall =
  | { readonly outcome: 'answered'; readonly result: CheckedResult }
  | { readonly outcome: FilterOutcome; readonly note: string };

/** What the filters decided: every test they left out, by test id, and one decision per filter that ran. */
interface AppliedTestFilters {
  readonly excluded: ReadonlyMap<string, TestExclusion>;
  readonly decisions: readonly FilterDecision[];
}

/** A filter's answer once checked: what it left out, with each reason, and its note, redacted and cut; no note when it left none. */
interface CheckedResult {
  readonly exclude: readonly (readonly [string, string])[];
  readonly note: string | undefined;
}

/** The most code points a stored reason, note, or log line keeps, on one line. */
const MAX_FILTER_TEXT = 1024;

/** The most code points an error quotes of a key or test id a filter chose. */
const MAX_QUOTED = 200;

const RESULT_KEYS: ReadonlySet<string> = new Set(['exclude', 'note']);

/** How long a filter call may take before the run stops waiting for it, unless the harness sets `filterTimeout`. */
export const FILTER_TIMEOUT_MS = 300_000;

/** What `--changed-since` says when the config has no test filter for it to run. */
const NO_FILTERS = 'warning: --changed-since: the config has no filters, so every test runs';

/**
 * The loaded config as `changes.files` spells it, relative to the repository
 * root: its directory resolved on disk, its own name kept, since git lists a
 * symlinked config under the link's path. `undefined` outside the repository,
 * where no changed file can name it.
 */
function repoConfigFile(configPath: string, root: string): string | undefined {
  const relative = path.relative(root, path.join(onDiskPath(path.dirname(configPath)), path.basename(configPath)));
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return undefined;
  return relative.split(path.sep).join('/');
}

/**
 * The second selection pass, which `run` and `list` share. `first` is the
 * selection every flag made, `--shard` included, so each shard machine hands
 * the filters its own slice and the cut never depends on what they answer.
 * Without a filter in the config, `first` stands, and so it does, with
 * `run.changes.skipped` saying why, on a `--last-failed` rerun, whose
 * tests are owed, with no test to judge (git is asked for neither), and
 * when no file changed since the merge base. Otherwise the exclusions go into a selection with the same flags,
 * which serial groups and sessions settle like any other filter; an empty
 * result is the filters' doing, or pass 1's under `passWithNoTests`, and
 * passes. Each decision's line goes to `options.notice`.
 */
export async function filterSelection(first: Selection, options: FilterSelectionOptions): Promise<FilteredSelection> {
  const { config, collection, selectionFilters, signal, notice } = options;
  if (config.filters.length === 0) {
    if (!signal.aborted) notice(NO_FILTERS);
    return { selection: first, records: [], changes: undefined };
  }
  /** `first` stands, for `record.skipped`, said as `message` or `<why>, so no filter ran`. */
  const skip = (record: ReportChanges & { readonly skipped: string }, message = `${record.skipped}, so no filter ran`): FilteredSelection => {
    notice(message);
    return { selection: first, records: [], changes: record };
  };
  if (selectionFilters.lastFailed !== undefined) return skip({ skipped: '--last-failed' }, '--last-failed: the tests the last run owes run without filters');
  const candidates = filterCandidates(first);
  if (candidates.length === 0) return skip({ skipped: 'no tests to judge' });
  // Spelled as on disk, as `changes.root` is, so a filter can join the two.
  const projectRoot = onDiskPath(config.projectRoot);
  const changes = await findChanges({ cwd: projectRoot, changedSince: options.changedSince, signal });
  const counts = { base: changes.base, files: changes.files.length };
  if (changes.files.length === 0) return skip({ ...counts, skipped: `no files changed since ${shortCommit(changes.base)}` });
  notice(`judging ${plural(changes.files.length, 'file')} changed since ${shortCommit(changes.base)}`);
  const applied = await applyTestFilters(config.filters, candidates, {
    projectRoot,
    changes,
    configFile: config.configPath === undefined ? undefined : repoConfigFile(config.configPath, changes.root),
    secrets: config.allSecrets,
    collectedIds: new Set(collection.tests.map((test) => test.id)),
    timeoutMs: options.timeoutMs ?? FILTER_TIMEOUT_MS,
    signal,
    notice,
    step: options.step ?? ((_name, work) => work()),
  });
  const selection = select(collection, config, { ...selectionFilters, excluded: applied.excluded }, { passWithNoTests: true });
  const records = filterRecords(applied.decisions, selection);
  for (const record of records) {
    const summary = filterSummary(record);
    if (summary !== undefined) notice(summary);
  }
  return { selection, records, changes: counts };
}

/**
 * The tests a filter may leave out: one frozen candidate per ordinary test
 * with at least one pair the selection runs, in report order, with the file
 * of the setup test that saves its session when it uses one. Setup tests,
 * explicit and capability skips, and tests filtered on every target are
 * never candidates.
 */
export function filterCandidates(selection: Selection): readonly TestFilterCandidate[] {
  const producers = new Map<string, string>();
  for (const { test } of selection.pairs) {
    if (test.kind === 'setup') for (const session of test.sessions) producers.set(session, test.file);
  }
  const tests = new Map<string, { readonly test: TestTargetPair['test']; readonly setupFile: string | undefined }>();
  for (const { test, options, disposition } of selection.pairs) {
    if (test.kind !== 'test' || disposition !== 'run' || tests.has(test.id)) continue;
    tests.set(test.id, { test, setupFile: options.session === undefined ? undefined : producers.get(options.session) });
  }
  return Object.freeze(
    [...tests.values()]
      .toSorted((a, b) => compareTests(a.test, b.test))
      .map(({ test, setupFile }) =>
        Object.freeze({
          id: test.id,
          file: test.file,
          titlePath: Object.freeze([...test.titlePath]),
          tags: Object.freeze([...test.tags]),
          ...(setupFile === undefined ? {} : { setupFile }),
        }),
      ),
  );
}

/**
 * Calls each filter in order on the tests the ones before it kept, so the
 * result is their intersection. A filter whose input is empty is not called.
 * A filter that throws, answers with something other than `{ exclude, note? }`,
 * or runs past `scope.timeoutMs` leaves nothing out: the run warns and the
 * next filter is called on every test it was given. Reasons, notes, log
 * lines, and what a refused answer quotes are redacted and cut before
 * anything prints or records them.
 */
export async function applyTestFilters(
  filters: readonly TestFilter[],
  candidates: readonly TestFilterCandidate[],
  scope: TestFilterScope,
): Promise<AppliedTestFilters> {
  const excluded = new Map<string, TestExclusion>();
  const decisions: FilterDecision[] = [];
  let remaining = candidates;
  for (const filter of filters) {
    const { name } = filter;
    if (remaining.length === 0) {
      scope.notice(`${name}: no tests left to judge`);
      continue;
    }
    const input = Object.freeze([...remaining]);
    const call = await callFilter(filter, input, scope);
    if (call.outcome !== 'answered') {
      // Said now, not with the summaries: an interrupt during a later filter would drop them.
      scope.notice(`warning: ${name} ${call.note}`);
      decisions.push({ name, candidates: input.length, note: call.note, outcome: call.outcome });
      continue;
    }
    const { exclude, note } = call.result;
    for (const [id, reason] of exclude) excluded.set(id, { filter: name, reason });
    decisions.push({ name, candidates: input.length, ...(note === undefined ? {} : { note }) });
    remaining = remaining.filter((candidate) => !excluded.has(candidate.id));
  }
  return { excluded, decisions };
}

/**
 * Calls one filter on `input` inside its step, which checks the answer too,
 * so a refused one ends the step `failed` as a throw does. Past
 * `scope.timeoutMs` the call is abandoned with a `TimeoutError` on its
 * signal, and the process records the work it left behind at once. An
 * interrupt abandons the call and is `INTERRUPTED`, whatever the filter does
 * next. The filter's `log` does nothing once the call has ended.
 */
async function callFilter(filter: TestFilter, input: readonly TestFilterCandidate[], scope: TestFilterScope): Promise<FilterCall> {
  const { name } = filter;
  const { redact, redactFragments } = staticSecretLedger(scope.secrets);
  const interrupted = new E2EError('interrupted', 'INTERRUPTED', `interrupted while filter ${JSON.stringify(name)} ran`);
  if (scope.signal.aborted) throw interrupted;
  const budget = budgetText(scope.timeoutMs);
  let live = true;
  // A ref'd timer, never AbortSignal.timeout: with nothing else holding the event loop open, an unref'd one never fires and the CLI exits 13.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException(`filter ${JSON.stringify(name)} did not finish within ${budget}`, 'TimeoutError')), scope.timeoutMs);
  const signal = AbortSignal.any([scope.signal, deadline.signal]);
  const context: TestFilterContext = Object.freeze({
    projectRoot: scope.projectRoot,
    changes: scope.changes,
    configFile: scope.configFile,
    signal,
    log: (line: string) => {
      if (live) scope.notice(`${name}: ${cut(redact(String(line)))}`);
    },
    redact: (text: string) => redactFragments(String(text)),
  });
  /** A call that leaves nothing out, its note ending in `detail`, so a long one is what the cut shortens. */
  const failed = (problem: string, detail: unknown): FilterCall => ({ outcome: 'failed', note: cut(`${problem}, so it leaves nothing out: ${redact(errorMessage(detail))}`) });
  try {
    return await scope.step(name, async () => {
      let raw: unknown;
      try {
        raw = await withAbort(() => Promise.resolve().then(() => filter.filter(input, context)), signal, () => interrupted);
      } catch (cause) {
        if (scope.signal.aborted) throw cause;
        if (!deadline.signal.aborted) return failed('failed', cause);
        leaveWorkBehind();
        return { outcome: 'timed-out', note: cut(`did not finish within ${budget}, so it leaves nothing out`) };
      }
      try {
        return { outcome: 'answered', result: checkedResult(raw, input, scope.collectedIds, redact) };
      } catch (cause) {
        return failed('returned an invalid result', cause);
      }
    });
  } catch (cause) {
    if (!scope.signal.aborted) throw cause;
    // A watch key cancels a run without exit 130: the call it abandoned must not keep the CLI open once the session quits.
    leaveWorkBehind();
    throw interrupted;
  } finally {
    clearTimeout(timer);
    live = false;
  }
}

/**
 * The report's record of each filter that ran. `excluded` counts the
 * distinct tests the final selection leaves out on the filter's word, so a
 * test it named that came back with its serial group is not counted.
 */
export function filterRecords(decisions: readonly FilterDecision[], selection: Selection): ReportFilter[] {
  const leftOut = leftOutTests(selection.pairs.map((pair) => ({ testId: pair.test.id, skip: pair.skip })));
  return decisions.map(({ name, candidates, ...rest }) => ({ name, candidates, excluded: leftOut.get(name) ?? 0, ...rest }));
}

/**
 * One filter's summary line for the run notices and `e2e list`: what it
 * kept and left out of what it was given, in tests, and its note. A filter
 * that failed or outran the deadline has none: `applyTestFilters` warned
 * about it as the call ended.
 */
export function filterSummary(record: ReportFilter): string | undefined {
  if (record.outcome !== undefined) return undefined;
  const note = record.note === undefined ? '' : ` (${record.note})`;
  return `${record.name} ${filterDecision(record.candidates, record.excluded)}${note}`;
}

/** `text` as one line of at most 1024 code points, the last of them an ellipsis when it was longer. */
function cut(text: string): string {
  return ellipsize(collapseText(text), MAX_FILTER_TEXT);
}

/** A key or test id a filter chose, as an error quotes it: redacted, then at most 200 code points. */
function quoted(text: string, redact: (text: string) => string): string {
  return JSON.stringify(ellipsize(redact(text), MAX_QUOTED));
}

/**
 * Checks a filter's answer: `{ exclude, note? }`, every excluded id a
 * collected test with a non-empty reason, and a string note. An id of a
 * collected test the filter was not given, such as a setup test or one
 * `--shard` or an earlier filter left out, is ignored: that test's fate is
 * settled. Anything else is refused rather than guessed at, and the filter
 * leaves nothing out.
 */
function checkedResult(
  raw: unknown,
  input: readonly TestFilterCandidate[],
  collectedIds: ReadonlySet<string>,
  redact: (text: string) => string,
): CheckedResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`expected { exclude, note? }, got ${describeValue(raw)}`);
  }
  const unknown = Object.keys(raw).find((key) => !RESULT_KEYS.has(key));
  if (unknown !== undefined) {
    throw new Error(`unknown key ${quoted(unknown, redact)}: a filter returns { exclude: { [test.id]: reason }, note? }, and every test it doesn't name runs`);
  }
  const { exclude, note } = raw as { exclude?: unknown; note?: unknown };
  if (!isPlainObject(exclude)) {
    throw new Error(`exclude must be a plain object of test ids to reasons, got ${describeValue(exclude)}`);
  }
  const ids = new Set(input.map((candidate) => candidate.id));
  const entries = Object.entries(exclude);
  const stranger = entries.find(([id]) => !ids.has(id) && !collectedIds.has(id));
  if (stranger !== undefined) {
    throw new Error(`exclude names ${quoted(stranger[0], redact)}, which no collected test has; exclude takes test.id`);
  }
  const unexplained = entries.find(([, reason]) => typeof reason !== 'string' || collapseText(reason).length === 0);
  if (unexplained !== undefined) {
    const [id, reason] = unexplained;
    throw new Error(`the reason for ${quoted(id, redact)} must be a non-empty string, got ${describeValue(reason)}`);
  }
  if (note !== undefined && typeof note !== 'string') {
    throw new Error(`note must be a string, got ${describeValue(note)}`);
  }
  const kept = cut(redact(note ?? ''));
  return {
    exclude: (entries as [string, string][]).filter(([id]) => ids.has(id)).map(([id, reason]) => [id, cut(redact(reason))]),
    note: kept.length === 0 ? undefined : kept,
  };
}
