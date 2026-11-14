/**
 * The test runner's own public types: the config file's shape, reporters,
 * and test filters. Everything else a config names is in `types.ts`.
 */

import type { RunEvent, RunExitCode, RunStatus } from './run/events.ts';
import type { Report1Document } from './report/build.ts';
import type { ProjectConfig } from 'e2e-core/lib/types';

/** The reporters the runner ships, named by id; each is a `Reporter` on the same contract. */
export type BuiltinReporter = 'list' | 'json' | 'junit' | 'markdown';

/**
 * The run's report document, the one `.e2e/report.json` holds. Its
 * `schemaVersion` names the wire format (`report-1`), pinned by
 * `schema/report-v1.schema.json` in the package.
 */
export type Report = Report1Document;

/** What a reporter receives once the run is over and its report is on disk. */
export interface FinishedRun {
  /** The report-1 document, as written. */
  readonly report: Report;
  /** The same status `report.run.status` carries. */
  readonly status: RunStatus;
  /** The exit code the process will end with. */
  readonly exitCode: RunExitCode;
  /** Absolute project root, what the terminal shows paths relative to. */
  readonly projectRoot: string;
  /** Where `report.json` was written; undefined when the write failed or config never loaded. */
  readonly reportPath: string | undefined;
  /** Absolute directory the report's artifact paths are relative to: `<output>/results`, a directory per test. */
  readonly artifactsRoot: string;
  /** Where `--ai-trace` wrote the run's model calls, when it was requested. */
  readonly aiTracePath: string | undefined;
  /**
   * The trace the runner wrote for each test that kept one (by its `trace`
   * mode, a failed one by default), by report result id, as a path from the
   * project root (`.e2e/results/checkout-applies-the-coupon-1a2b3c4d5e6f7a8b/trace.md`).
   */
  readonly traces: ReadonlyMap<string, string>;
  /**
   * The report `--last-failed` selected from, when the run was given that
   * flag: the run before this one, whose tests that did not fail were left
   * out here. A reporter that keeps one place current folds this run into it.
   */
  readonly lastRun?: Report;
  /**
   * Replaces every fixed-value secret and credential password in `text`, and
   * any run of 8 or more consecutive characters of one. The report is
   * redacted already; this is for text a reporter adds from elsewhere, such
   * as lines of a test file.
   */
  redact(text: string): string;
}

/** Rows a reporter hands back for the terminal summary: a label and its text, a URL or a path. */
export type ReporterSummary = readonly { readonly label: string; readonly text: string }[];

/**
 * A reporter in `reporters`, the contract the built-in `list`, `json`,
 * `junit`, and `markdown` reporters implement too. `onEvent` sees every run event as it
 * happens, exactly what the `list` reporter renders, and must not block: a
 * throw quarantines it for the rest of the run. Event types are added over
 * time; a reporter handles the ones it knows and ignores the rest. `onRunFinished` runs once
 * `report.json` is written and the summary has printed; it is awaited within
 * a fixed budget, and the rows it resolves with print under the summary. Its
 * `signal` aborts when that budget runs out or the run is forced to stop, so
 * a reporter hands it to its requests and leaves nothing running behind. A
 * reporter can never change the run's status or exit code: a failure or a
 * timeout is one line on stderr. Like every live value, a reporter never
 * crosses a process boundary; workers construct their own copy when they
 * load the config module and never call it, so constructing one must have no
 * side effects.
 */
export interface Reporter {
  /** Label in diagnostics; required. */
  readonly name: string;
  /** Every run event as it happens. Must not block or throw. */
  onEvent?(event: RunEvent): void;
  /** Runs once the report is written and the summary printed; awaited one minute. Returned rows print under the summary. */
  onRunFinished?(run: FinishedRun, signal: AbortSignal): Promise<ReporterSummary | void>;
}

/**
 * Leaves collected tests out of a run before anything starts. Called at most
 * once, in the runner process; workers load the config too and never call
 * it, so constructing one must have no side effects: read git, the
 * environment, or the network inside `filter`. A call that throws, returns
 * an invalid result, or runs past 5 minutes leaves nothing out. A failed call
 * scores nothing either, unless the error it throws has a `relevance`
 * property shaped like `TestFilterResult.relevance`: the run checks it as it
 * checks a result's, starts the likeliest tests first, and still warns of the
 * failure. A call past 5 minutes is abandoned, and nothing it throws after
 * that is read.
 */
export interface TestFilter {
  /** Names the filter in the report and in errors: ASCII letters, numbers, `_`, `-`, and `.`, not only dots, at most 256 characters, unique among `filters`. */
  readonly name: string;
  /** Decides which of `tests` to leave out; every test the result does not name runs. */
  readonly filter: (tests: readonly TestFilterCandidate[], context: TestFilterContext) => TestFilterResult | Promise<TestFilterResult>;
}

/** One test a filter may leave out: what names it, never its body. */
export interface TestFilterCandidate {
  /** Stable test id (`<file>::<titles>`), the report's `testId`, and the key `exclude` and `relevance` take. */
  readonly id: string;
  /** Project-relative POSIX path of the test file. */
  readonly file: string;
  /** The describe titles, then the test title. */
  readonly titlePath: readonly string[];
  /** The describe chain's tags, outermost first, then the test's own. */
  readonly tags: readonly string[];
  /** Project-relative POSIX path of the setup test file that saves the test's session; absent when the test uses none. */
  readonly setupFile?: string;
}

/** What a run's test filters judge: every file that differs from the base commit. */
export interface TestFilterChanges {
  /** The commit the change is measured from: the merge base of the base ref and HEAD. */
  readonly base: string;
  /** Absolute path of the git repository root, spelled as on disk like `projectRoot`; `files` are relative to it. */
  readonly root: string;
  /**
   * Repository-relative POSIX paths of every file added, modified, or
   * deleted since `base`, both paths of a rename, uncommitted and untracked
   * files included; sorted, never empty. Spelled as git prints them, which
   * on macOS is NFC while a test's `file` keeps the bytes on disk, so
   * compare a non-ASCII path with `.normalize('NFC')` on both sides.
   */
  readonly files: readonly string[];
}

/** What the runner hands a filter besides its tests. */
export interface TestFilterContext {
  /** Absolute project root, spelled as on disk like `changes.root`: symlinks resolved, names in on-disk case; a test's `file` is relative to it. */
  readonly projectRoot: string;
  /** The change the filter judges; the same for every filter of the run. */
  readonly changes: TestFilterChanges;
  /**
   * The config file this run loaded, whatever its name, as a POSIX path
   * relative to `changes.root` like `changes.files`, in its on-disk bytes
   * (compare in NFC, as with a test's `file`); `undefined` when the run was
   * given a config object or loaded one outside the repository.
   */
  readonly configFile?: string | undefined;
  /**
   * Aborts when the run is interrupted, or with a `TimeoutError` reason after
   * 5 minutes; hand it to every model and network call.
   */
  readonly signal: AbortSignal;
  /** Prints one progress line as a run notice. */
  log(line: string): void;
  /** Replaces every fixed-value secret and credential password in `text`, and any run of 8 or more consecutive characters of one. */
  redact(text: string): string;
}

/** A filter's answer: every test it does not name runs. */
export interface TestFilterResult {
  /** The tests to leave out, by `TestFilterCandidate.id`, each with the reason the report shows; a test of a serial group still runs when another test of its group does. */
  readonly exclude: Readonly<Record<string, string>>;
  /**
   * How likely each test is to fail on this change, from 0 to 1, by
   * `TestFilterCandidate.id`. Each target starts the files of the likeliest
   * tests first, in bands at 75%, 50%, and 25%, and targets go by the band of
   * their best file, ties in config order. A test no filter scores counts as
   * 0, and one several filters score keeps its highest. It never leaves a
   * test out.
   */
  readonly relevance?: Readonly<Record<string, number>>;
  /** One line about the whole decision, such as `the diff is too large to judge`. */
  readonly note?: string;
}

/** The config an `e2e.config.ts` default-exports, through `defineConfig`. */
export interface E2EConfig extends ProjectConfig {
  /**
   * Output renderers and reporter objects. `junit` writes `<output>/junit.xml`,
   * `markdown` writes `<output>/summary.md`, `json` prints the report and
   * excludes `list`; a `Reporter` object runs
   * beside them and `--reporter` never removes it.
   */
  reporters?: readonly (BuiltinReporter | Reporter)[];
  /** Test filters, in order, run with `--changed-since`: each judges the tests the one before it kept. */
  filters?: readonly TestFilter[];
}
