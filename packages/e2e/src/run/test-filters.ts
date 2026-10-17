/** Test filters (`filters`): which apply, what they are given, calling them, and what they decided. */

import type { ResolvedConfig } from '../config/resolve.ts';
import type { Selection, TestExclusion, TestTargetPair } from '../collect/select.ts';
import { describeValue } from '../config/validate.ts';
import { leaveWorkBehind } from '../internal/abandoned.ts';
import { E2EError, errorMessage } from '../internal/errors.ts';
import { isPlainObject } from '../internal/options.ts';
import { collapseText } from '../internal/text.ts';
import { budgetText, withAbort } from '../internal/time.ts';
import { compareTests, type ReportFilter } from '../report/build.ts';
import { ellipsize, filterDecision } from '../report/format.ts';
import type { TestFilter, TestFilterCandidate, TestFilterChanges, TestFilterContext } from '../types.ts';
import { staticSecretLedger } from './secrecy.ts';

/** One filter's decision: how many tests it was given, its note, and whether it left nothing out because it failed or outran the deadline. */
interface FilterDecision {
  /** The filter's `name`. */
  readonly name: string;
  /** How many tests it was given. */
  readonly candidates: number;
  /** The filter's note, redacted and cut. */
  readonly note?: string;
  /** Set when the filter outran the deadline: the run stopped waiting, and it left nothing out. */
  readonly timedOut?: true;
  /** Set when the filter threw or answered with something other than `{ exclude, note? }`: it left nothing out. */
  readonly failed?: true;
}

/** What `applyTestFilters` hands each filter and where its lines go. */
export interface TestFilterScope {
  readonly projectRoot: string;
  /** The change every filter judges. */
  readonly changes: TestFilterChanges;
  readonly secrets: ResolvedConfig['allSecrets'];
  /** The id of every collected test, setup tests included: an `exclude` naming one a filter was not given is ignored, since that test's fate is settled. */
  readonly collectedIds: ReadonlySet<string>;
  /** How long each filter call may take before the run stops waiting for it. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** One line, already prefixed and redacted. */
  readonly notice: (message: string) => void;
  /** `run` wraps each call in the `filter` setup step, which ends `failed` or `timed out` for a call that left nothing out; `list` calls it bare. */
  readonly step: (name: string, work: () => Promise<FilterCall>) => Promise<FilterCall>;
}

/** How one filter call ended: with its answer, checked; thrown or refused, with why; or abandoned past the deadline. */
export type FilterCall =
  | { readonly outcome: 'answered'; readonly result: CheckedResult }
  | { readonly outcome: 'failed'; readonly problem: 'failed' | 'returned an invalid result'; readonly detail: string }
  | { readonly outcome: 'timed out' };

/** What the filters decided: every test they left out, by test id, and one decision per filter that ran. */
interface AppliedTestFilters {
  readonly excluded: ReadonlyMap<string, TestExclusion>;
  readonly decisions: readonly FilterDecision[];
}

/** A filter's answer once checked: what it left out, with each reason, and its note. */
export interface CheckedResult {
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
 * next filter is called on every test it was given. A call past the deadline
 * is abandoned with a `TimeoutError` on its signal, and the process records
 * the work it left behind at once. An interrupt abandons the call and is
 * `INTERRUPTED`, whatever the filter does next. Reasons, notes, log lines,
 * and what a refused answer quotes are redacted and cut before anything
 * prints or records them; a filter's `log` does nothing once its call has
 * ended.
 */
export async function applyTestFilters(
  filters: readonly TestFilter[],
  candidates: readonly TestFilterCandidate[],
  scope: TestFilterScope,
): Promise<AppliedTestFilters> {
  const { redact } = staticSecretLedger(scope.secrets);
  const excluded = new Map<string, TestExclusion>();
  const decisions: FilterDecision[] = [];
  const budget = budgetText(scope.timeoutMs);
  let remaining = candidates;
  for (const filter of filters) {
    const { name } = filter;
    if (remaining.length === 0) {
      scope.notice(`${name}: no tests left to judge`);
      continue;
    }
    if (scope.signal.aborted) throw interruptedError(name);
    let live = true;
    // A ref'd timer, never AbortSignal.timeout: with nothing else holding the event loop open, an unref'd one never fires and the CLI exits 13.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException(`${describeFilter(filter)} did not finish within ${budget}`, 'TimeoutError')), scope.timeoutMs);
    const signal = AbortSignal.any([scope.signal, deadline.signal]);
    const context: TestFilterContext = Object.freeze({
      projectRoot: scope.projectRoot,
      changes: scope.changes,
      signal,
      log: (line: string) => {
        if (live) scope.notice(`${name}: ${cut(redact(String(line)))}`);
      },
      redact: (text: string) => redact(String(text)),
    });
    const input = Object.freeze([...remaining]);
    let call: FilterCall;
    try {
      // The answer is checked inside the step, so a refused one ends it `failed` as a throw does.
      call = await scope.step(name, async (): Promise<FilterCall> => {
        let raw: unknown;
        try {
          raw = await withAbort(() => Promise.resolve().then(() => filter.filter(input, context)), signal, () => interruptedError(name));
        } catch (cause) {
          if (scope.signal.aborted) throw interruptedError(name);
          // Past the deadline the call is abandoned, whatever it does next.
          if (deadline.signal.aborted) return { outcome: 'timed out' };
          return { outcome: 'failed', problem: 'failed', detail: errorMessage(cause) };
        }
        try {
          return { outcome: 'answered', result: checkedResult(raw, input, scope, redact) };
        } catch (cause) {
          return { outcome: 'failed', problem: 'returned an invalid result', detail: errorMessage(cause) };
        }
      });
    } catch (cause) {
      if (scope.signal.aborted) {
        // A watch key cancels a run without exit 130: the call it abandoned must not keep the CLI open once the session quits.
        leaveWorkBehind();
        throw interruptedError(name);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      live = false;
    }
    if (call.outcome !== 'answered') {
      // Said now, not with the summaries: an interrupt during a later filter would drop them.
      if (call.outcome === 'timed out') leaveWorkBehind();
      // The detail goes last, so a long one is what the cut shortens.
      const note = cut(call.outcome === 'timed out' ? `did not finish within ${budget}: running every test it was given` : `${call.problem}, running every test it was given: ${redact(call.detail)}`);
      scope.notice(`warning: ${name} ${note}`);
      decisions.push({ name, candidates: input.length, note, ...(call.outcome === 'timed out' ? { timedOut: true } : { failed: true }) });
      continue;
    }
    const { result } = call;
    for (const [id, reason] of result.exclude) excluded.set(id, { filter: name, reason: cut(redact(reason)) });
    const note = result.note === undefined ? undefined : cut(redact(result.note));
    decisions.push({ name, candidates: input.length, ...(note === undefined || note.length === 0 ? {} : { note }) });
    remaining = remaining.filter((candidate) => !excluded.has(candidate.id));
  }
  return { excluded, decisions };
}

/**
 * The report's record of each filter that ran. `excluded` counts the
 * distinct tests the final selection leaves out on the filter's word, so a
 * test it named that came back with its serial group is not counted.
 */
export function filterRecords(decisions: readonly FilterDecision[], selection: Selection): ReportFilter[] {
  const leftOut = new Map<string, Set<string>>();
  for (const pair of selection.pairs) {
    const name = pair.skip?.filter;
    if (name === undefined) continue;
    const tests = leftOut.get(name) ?? new Set<string>();
    tests.add(pair.test.id);
    leftOut.set(name, tests);
  }
  return decisions.map((decision) => ({
    name: decision.name,
    candidates: decision.candidates,
    excluded: leftOut.get(decision.name)?.size ?? 0,
    ...(decision.note === undefined ? {} : { note: decision.note }),
    ...(decision.timedOut === true ? { timedOut: true as const } : {}),
    ...(decision.failed === true ? { failed: true as const } : {}),
  }));
}

/**
 * One filter's summary line for the run notices and `e2e list`: what it
 * kept and left out of what it was given, in tests, and its note. A filter
 * that failed or outran the deadline has none: `applyTestFilters` warned
 * about it as the call ended.
 */
export function filterSummary(record: ReportFilter): string | undefined {
  if (record.timedOut === true || record.failed === true) return undefined;
  const note = record.note === undefined ? '' : ` (${record.note})`;
  return `${record.name} ${filterDecision(record.candidates, record.excluded)}${note}`;
}

/** `filter "decision"`, as messages name a filter. */
function describeFilter(filter: TestFilter): string {
  return `filter ${JSON.stringify(filter.name)}`;
}

/** The interrupt that cut a filter's call short. */
function interruptedError(name: string): E2EError {
  return new E2EError('interrupted', 'INTERRUPTED', `interrupted while filter ${JSON.stringify(name)} ran`);
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
  scope: Pick<TestFilterScope, 'collectedIds'>,
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
  const stranger = entries.find(([id]) => !ids.has(id) && !scope.collectedIds.has(id));
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
  return { exclude: (entries as [string, string][]).filter(([id]) => ids.has(id)), note };
}
