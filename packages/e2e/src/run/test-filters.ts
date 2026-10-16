/** Test filters (`filters`): which apply, what they are given, calling them, and what they decided. */

import type { ResolvedConfig } from '../config/resolve.ts';
import type { Selection, TestExclusion, TestTargetPair } from '../collect/select.ts';
import { describeValue } from '../config/validate.ts';
import { leaveWorkBehind } from '../internal/abandoned.ts';
import { ConfigurationError, E2EError, errorMessage, InfrastructureError, isE2EError } from '../internal/errors.ts';
import { isPlainObject } from '../internal/options.ts';
import { collapseText } from '../internal/text.ts';
import { budgetText, withAbort } from '../internal/time.ts';
import { compareTests, type ReportFilter } from '../report/build.ts';
import { ellipsize, filterDecision } from '../report/format.ts';
import type { TestFilter, TestFilterCandidate, TestFilterChanges, TestFilterContext } from '../types.ts';
import { staticSecretLedger } from './secrecy.ts';

/** One filter's decision: how many tests it was given, its note, and whether the run stopped waiting for it. */
interface FilterDecision {
  /** The filter's `name`. */
  readonly name: string;
  /** How many tests it was given. */
  readonly candidates: number;
  /** The filter's note, redacted and cut. */
  readonly note?: string;
  /** Set when the filter outran the deadline: the run stopped waiting, and it left nothing out. */
  readonly timedOut?: true;
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
  /** `run` wraps each call in the `filter` setup step, which ends `timed out` for a call past the deadline; `list` calls it bare. */
  readonly step: (name: string, work: () => Promise<FilterCall>) => Promise<FilterCall>;
}

/** How one filter call ended: with its answer, checked, or abandoned past the deadline. */
export type FilterCall = { readonly timedOut: false; readonly result: CheckedResult } | { readonly timedOut: true };

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
 * with at least one pair the selection runs, in report order. Setup tests,
 * explicit and capability skips, and tests filtered on every target are
 * never candidates.
 */
export function filterCandidates(selection: Selection): readonly TestFilterCandidate[] {
  const tests = new Map<string, TestTargetPair['test']>();
  for (const { test, disposition } of selection.pairs) {
    if (test.kind === 'test' && disposition === 'run' && !tests.has(test.id)) tests.set(test.id, test);
  }
  return Object.freeze(
    [...tests.values()].toSorted(compareTests).map((test) =>
      Object.freeze({
        id: test.id,
        file: test.file,
        titlePath: Object.freeze([...test.titlePath]),
        tags: Object.freeze([...test.tags]),
      }),
    ),
  );
}

/**
 * The file of the setup test that saves each candidate's session, by test
 * id, for the candidates of `selection` that use one: a change to that file
 * runs them without filters, and so runs the setup.
 */
export function sessionSetupFiles(selection: Selection): ReadonlyMap<string, string> {
  const producers = new Map<string, string>();
  for (const { test } of selection.pairs) {
    if (test.kind === 'setup') for (const session of test.sessions) producers.set(session, test.file);
  }
  const files = new Map<string, string>();
  for (const { test, options, disposition } of selection.pairs) {
    const file = options.session === undefined ? undefined : producers.get(options.session);
    if (test.kind === 'test' && disposition === 'run' && file !== undefined) files.set(test.id, file);
  }
  return files;
}

/**
 * Calls each filter in order on the tests the ones before it kept, so the
 * result is their intersection. A filter whose input is empty is not called.
 * A throw is `FILTER_FAILED`, or the thrown configuration error under the
 * filter's name; an interrupt abandons the call and is `INTERRUPTED`, never
 * `FILTER_FAILED`. A call past `scope.timeoutMs` is abandoned too: its
 * signal aborts with a `TimeoutError`, it leaves nothing out, and the next
 * filter is called. The warning prints and the process records the work it
 * left behind at once, so both hold when a later filter fails; an interrupt
 * records the call it abandoned too. Reasons, notes, log lines, and what a
 * refused answer's error quotes are redacted and cut before anything prints
 * or records them; a filter's `log` does nothing once its call has ended.
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
      // The answer is checked inside the step, so a refused one fails it as a throw does.
      call = await scope.step(name, async () => {
        let raw: unknown;
        try {
          raw = await withAbort(() => Promise.resolve().then(() => filter.filter(input, context)), signal, () => interruptedError(name));
        } catch (cause) {
          if (scope.signal.aborted) throw interruptedError(name);
          // Past the deadline the call is abandoned, whatever it does next.
          if (deadline.signal.aborted) return { timedOut: true };
          throw thrownError(filter, cause, redact);
        }
        try {
          return { timedOut: false, result: checkedResult(raw, filter, input, scope, redact) };
        } catch (cause) {
          if (isE2EError(cause) && cause.code === 'FILTER_FAILED') throw cause;
          throw invalidResult(filter, errorMessage(cause), redact, cause);
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
    if (call.timedOut) {
      // Said now, not with the summaries: a later filter's failure would drop them.
      leaveWorkBehind();
      const note = `did not finish within ${budget}: running every test it was given`;
      scope.notice(`warning: ${name} ${note}`);
      decisions.push({ name, candidates: input.length, note, timedOut: true });
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
  }));
}

/**
 * One filter's summary line for the run notices and `e2e list`: what it
 * kept and left out of what it was given, in tests, and its note. A filter
 * that outran the deadline has none: `applyTestFilters` warned about it as
 * it gave up the call.
 */
export function filterSummary(record: ReportFilter): string | undefined {
  if (record.timedOut === true) return undefined;
  const note = record.note === undefined ? '' : ` (${record.note})`;
  return `${record.name} ${filterDecision(record.candidates, record.excluded)}${note}`;
}

/** `filter "decision"`, as errors name a filter. */
function describeFilter(filter: TestFilter): string {
  return `filter ${JSON.stringify(filter.name)}`;
}

/**
 * What a filter's throw fails the run with: a configuration error keeps its
 * class and code under the filter's name, anything else is `FILTER_FAILED`.
 */
function thrownError(filter: TestFilter, cause: unknown, redact: (text: string) => string): E2EError {
  if (isE2EError(cause) && cause.category === 'configuration') {
    return new ConfigurationError(cause.code, `${describeFilter(filter)}: ${redact(cause.message)}`, { cause });
  }
  return filterFailed(filter, `failed: ${redact(errorMessage(cause))}`, cause);
}

/** The interrupt that cut a filter's call short. */
function interruptedError(name: string): E2EError {
  return new E2EError('interrupted', 'INTERRUPTED', `interrupted while filter ${JSON.stringify(name)} ran`);
}

/** A filter that threw or answered with something other than `{ exclude, note? }`. */
function filterFailed(filter: TestFilter, detail: string, cause?: unknown): InfrastructureError {
  return new InfrastructureError('FILTER_FAILED', `${describeFilter(filter)} ${detail}`, cause === undefined ? {} : { cause });
}

/** A filter's answer refused for `issue`, which is redacted and cut like a reason. */
function invalidResult(filter: TestFilter, issue: string, redact: (text: string) => string, cause?: unknown): InfrastructureError {
  return filterFailed(filter, `returned an invalid result: ${cut(redact(issue))}`, cause);
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
 * settled. Anything else fails the run with `FILTER_FAILED` rather than
 * guessing.
 */
function checkedResult(
  raw: unknown,
  filter: TestFilter,
  input: readonly TestFilterCandidate[],
  scope: Pick<TestFilterScope, 'collectedIds'>,
  redact: (text: string) => string,
): CheckedResult {
  /** The refusal of this filter's answer for `issue`. */
  const invalid = (issue: string): InfrastructureError => invalidResult(filter, issue, redact);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid(`expected { exclude, note? }, got ${describeValue(raw)}`);
  }
  const unknown = Object.keys(raw).find((key) => !RESULT_KEYS.has(key));
  if (unknown !== undefined) {
    throw invalid(`unknown key ${quoted(unknown, redact)}: a filter returns { exclude: { [test.id]: reason }, note? }, and every test it doesn't name runs`);
  }
  const { exclude, note } = raw as { exclude?: unknown; note?: unknown };
  if (!isPlainObject(exclude)) {
    throw invalid(`exclude must be a plain object of test ids to reasons, got ${describeValue(exclude)}`);
  }
  const ids = new Set(input.map((candidate) => candidate.id));
  const entries = Object.entries(exclude);
  const stranger = entries.find(([id]) => !ids.has(id) && !scope.collectedIds.has(id));
  if (stranger !== undefined) {
    throw invalid(`exclude names ${quoted(stranger[0], redact)}, which no collected test has; exclude takes test.id`);
  }
  const unexplained = entries.find(([, reason]) => typeof reason !== 'string' || collapseText(reason).length === 0);
  if (unexplained !== undefined) {
    const [id, reason] = unexplained;
    throw invalid(`the reason for ${quoted(id, redact)} must be a non-empty string, got ${describeValue(reason)}`);
  }
  if (note !== undefined && typeof note !== 'string') {
    throw invalid(`note must be a string, got ${describeValue(note)}`);
  }
  return { exclude: (entries as [string, string][]).filter(([id]) => ids.has(id)), note };
}
