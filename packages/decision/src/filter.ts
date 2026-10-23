import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestFilter, TestFilterCandidate, TestFilterChanges, TestFilterContext, TestFilterResult } from 'e2e';
import { ConfigurationError } from 'e2e/engine';
import { decideBooleans, requireDecide } from './decide.ts';
import { checkModel, checkProviderOptions } from './model.ts';
import type { DecisionFilterOptions } from './types.ts';
const exec = promisify(execFile);
/** A test the model rates less likely than this to be affected is left out. */
const MIN_PROBABILITY = 0.2;
/** Most UTF-8 bytes of state, the diff and the files, one call sends: Jev takes 32k tokens of state and a question, and English text runs about 3.4 bytes a token, other scripts more. */
const MAX_STATE_BYTES = 80_000;
/** A longer diff is not sent, and the filter leaves nothing out: each call keeps room for the files. */
const MAX_DIFF_BYTES = 60_000;
/** Most questions one call asks. */
const MAX_QUESTIONS = 200;
/** Most calls in flight at once. */
const CONCURRENCY = 8;
/** Failed calls after which no more are made: the model or its key is likely down. */
const MAX_FAILURES = 3;
/** What `git diff` may print, far past MAX_DIFF_BYTES so a long diff is measured rather than lost. */
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;
/** Most characters of paths one `git diff` names, well within the 32,767 of a Windows command line. */
const MAX_PATHSPEC_CHARS = 16_000;
/** Plain `git diff` output whatever the repository's config says. */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-U3'];
/**
 * Files that can change what any test does, by name at any depth: the
 * config files e2e discovers, the lockfiles of every package manager, and
 * Gradle's version catalog. A change to one leaves nothing out.
 */
const RUN_ALL: ReadonlySet<string> = new Set([
  'e2e.config.ts',
  'e2e.config.mts',
  'e2e.config.js',
  'e2e.config.mjs',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Podfile.lock',
  'Package.resolved',
  'Cartfile.resolved',
  'gradle.lockfile',
  'buildscript-gradle.lockfile',
  'libs.versions.toml',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'pubspec.lock',
  'mix.lock',
  'packages.lock.json',
  'flake.lock',
  'MODULE.bazel.lock',
]);
/** What follows a test file's name in the directory of its stored screenshots. */
const SNAPSHOTS_SUFFIX = '-snapshots/';
/** How a valid model reads, for every model error. */
const EXAMPLE = "pass an AI SDK decision model, e.g. decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })";
/**
 * A test filter named `decision` that asks the decision model, test by
 * test, whether the change can affect what it checks, and whether it can
 * break the setup that saves the test's session, and leaves out the tests
 * unlikely on both counts. A change to the config the run loaded, any
 * file named like an e2e config, or a lockfile leaves nothing out, and a
 * test whose test file, setup file, or stored screenshots changed always
 * runs. A test the model does not judge runs,
 * and the note says why. When every call fails, as without a key, or git fails,
 * the filter throws, so the run warns and runs every test.
 */
export function decisionFilter(options: DecisionFilterOptions): TestFilter {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigurationError('INVALID_CONFIG', `decisionFilter() takes an options object; ${EXAMPLE}`);
  }
  requireDecide('decisionFilter');
  checkModel(options.model, { caller: 'decisionFilter', questionType: 'boolean', example: EXAMPLE });
  checkProviderOptions(options.providerOptions, 'decisionFilter');
  const { model, providerOptions } = options;
  const settings: DecisionFilterOptions = { model, ...(providerOptions === undefined ? {} : { providerOptions }) };
  return {
    name: 'decision',
    filter: (tests, context) =>
      judge(tests, context, settings).catch((error: unknown) => {
        // An abort ends with its reason, not the AbortError of a git or file read it cut short.
        context.signal.throwIfAborted();
        throw error;
      }),
  };
}
/** One question to the model, redacted: whether the change can affect a test, or break a setup file and the session it saves. */
type Question = { readonly kind: 'test'; readonly test: TestFilterCandidate; readonly text: string } | { readonly kind: 'setup'; readonly file: string; readonly text: string };
/** A file the model reads, under its key in `testFiles`, its size, and the questions asked about it. */
interface Subject {
  readonly key: string;
  readonly text: string;
  readonly bytes: number;
  readonly questions: Question[];
}
/** The files that go to the model in one call, by key, and the questions it asks. */
interface Batch {
  readonly testFiles: Record<string, string>;
  readonly questions: Question[];
}
/** What the calls that answered spent: how many, their tokens, and their cost in USD when the provider reports one. */
interface Spend {
  calls: number;
  tokens: number;
  costUsd: number | undefined;
  /** Set once a call that answered reported no cost, so a sum of the others would undercount. */
  uncosted: boolean;
}
/** What the model answered, by test id and by setup file, as the probability of true. */
interface Answers {
  readonly tests: Map<string, number>;
  readonly setups: Map<string, number>;
}
/**
 * Leaves nothing out when the loaded config or a `RUN_ALL` file of the
 * project changed, runs the tests the change touches directly without
 * asking, and asks the model
 * about the rest, and the setup files that save their sessions, against
 * the redacted diff and the redacted files, in calls of at most
 * `MAX_QUESTIONS`, `CONCURRENCY` at a time. A test is left out when both
 * it and its setup are unlikely to be affected. A failed call leaves its
 * tests in, and after `MAX_FAILURES` no more calls are made. The note names
 * the tests that ran without asking, what the model did not judge, and
 * what the calls spent. Throws when git or a file read fails, the first
 * failure's first line when calls fail and none answers, and on an abort.
 */
async function judge(given: readonly TestFilterCandidate[], context: TestFilterContext, options: DecisionFilterOptions): Promise<TestFilterResult> {
  const { changes, signal, log, redact } = context;
  const everything = runAllFile(context);
  if (everything !== undefined) return { exclude: {}, note: `${everything} changed, so the decision filter left nothing out` };
  const touched = touchedBy(context);
  const tests = given.filter((test) => !touched(test.file) && !touched(test.setupFile));
  const unasked = tests.length === given.length ? undefined : `${counted(given.length - tests.length, 'test')} ran without asking: the test file, setup file, or stored screenshots changed`;
  // A wrapper may hand on no tests, or the change touched them all: nothing to ask, and no diff to read.
  if (tests.length === 0) return unasked === undefined ? { exclude: {} } : { exclude: {}, note: unasked };
  const { modelId } = options.model;
  log(`asking ${modelId} about ${testsIn(tests)}`);
  const raw = await changeDiff(changes, signal);
  if (raw === '') return { exclude: {}, note: 'git printed no diff of the changed files, so the decision filter left nothing out' };
  if (Buffer.byteLength(raw) > MAX_DIFF_BYTES) return { exclude: {}, note: `the diff is over ${MAX_DIFF_BYTES / 1000} kB, so the decision filter left nothing out` };
  const diff = redact(raw);
  const { batches, tooLarge } = pack(await subjects(tests, context), Buffer.byteLength(diff));
  const { answers, spend, failures } = await askAll(batches, diff, options, signal);
  if (spend.calls === 0 && failures.length > 0) throw new Error(firstLine(failures[0]), { cause: failures[0] });
  const { exclude, missed } = verdicts(tests, answers);
  return answered(exclude, [unasked, missed.length === 0 ? undefined : `${modelId} did not judge ${testsIn(missed)}: ${unjudgedBecause(failures, tooLarge)}`], spend);
}
/** The tests to leave out, each with its reason, and the tests the model did not answer for, itself or its setup. */
function verdicts(tests: readonly TestFilterCandidate[], answers: Answers): { readonly exclude: Record<string, string>; readonly missed: readonly TestFilterCandidate[] } {
  const exclude: Record<string, string> = {};
  const missed: TestFilterCandidate[] = [];
  for (const test of tests) {
    const own = answers.tests.get(test.id);
    const setup = test.setupFile === undefined ? 0 : answers.setups.get(test.setupFile);
    if (own === undefined || setup === undefined) missed.push(test);
    else if (Math.max(own, setup) < MIN_PROBABILITY) exclude[test.id] = `${Math.round(Math.max(own, setup) * 100)}% likely affected`;
  }
  return { exclude, missed };
}
/** Why some tests went unjudged: the first failed call's first line, and the files too large to send with the diff. */
function unjudgedBecause(failures: readonly unknown[], tooLarge: readonly Subject[]): string {
  const why: string[] = [];
  if (failures.length > 0) why.push(firstLine(failures[0]));
  if (tooLarge.length > 0) why.push(`${tooLarge.length === 1 ? `${tooLarge[0]?.key} is` : `${counted(tooLarge.length, 'file')} are`} too large to send with the diff`);
  return why.join('; ');
}
/**
 * A path from the repository root, in POSIX form and NFC, as git names
 * files on macOS, for a project-relative `file`; `''` for the project
 * root itself when it is the repository root.
 */
function repoPath({ projectRoot, changes }: TestFilterContext, file: string): string {
  return path.relative(changes.root, path.join(projectRoot, file)).split(path.sep).join('/').normalize('NFC');
}
/**
 * The first changed file that leaves nothing out: the config the run
 * loaded, whatever its name, or a `RUN_ALL` file that belongs to the
 * project, one in the project directory or inside it, or in a directory
 * above it, as a workspace root's lockfile is. A sibling project's config
 * or lockfile, or one in a docs folder outside the project, goes to the
 * model. Without `configFile`, from an older e2e or a config object, only
 * the `RUN_ALL` names apply.
 */
function runAllFile(context: TestFilterContext): string | undefined {
  const project = repoPath(context, '.');
  const config = context.configFile?.normalize('NFC');
  return context.changes.files.find((file) => {
    if (file.normalize('NFC') === config) return true;
    if (!RUN_ALL.has(path.posix.basename(file))) return false;
    const directory = path.posix.dirname(file.normalize('NFC'));
    return directory === '.' || project === '' || directory === project || project.startsWith(`${directory}/`) || directory.startsWith(`${project}/`);
  });
}
/** Whether a project-relative file, or one of its stored screenshots, is in the change, each compared in NFC. */
function touchedBy(context: TestFilterContext): (file: string | undefined) => boolean {
  const changed = new Set(context.changes.files.map((file) => file.normalize('NFC')));
  const screenshotted = new Set<string>();
  for (const file of changed) {
    for (let at = file.indexOf(SNAPSHOTS_SUFFIX); at !== -1; at = file.indexOf(SNAPSHOTS_SUFFIX, at + 1)) screenshotted.add(file.slice(0, at));
  }
  return (file) => {
    if (file === undefined) return false;
    const key = repoPath(context, file);
    return changed.has(key) || screenshotted.has(key);
  };
}
/**
 * The files the model reads: each test file, then each setup file that
 * saves a test's session, keyed by their redacted path from the repository
 * root, as the diff names files, with their questions.
 */
async function subjects(tests: readonly TestFilterCandidate[], context: TestFilterContext): Promise<Subject[]> {
  const { projectRoot, signal, redact } = context;
  const setups = [...new Set(tests.flatMap((test) => (test.setupFile === undefined ? [] : [test.setupFile])))];
  const files = [...new Set([...tests.map((test) => test.file), ...setups])];
  const read = await Promise.all(files.map((file) => readFile(path.join(projectRoot, file), { encoding: 'utf8', signal })));
  const found = new Map<string, Subject>();
  files.forEach((file, i) => {
    const text = redact(read[i] ?? '');
    found.set(file, { key: redact(repoPath(context, file)), text, bytes: Buffer.byteLength(text), questions: [] });
  });
  for (const test of tests) {
    const { key, questions } = found.get(test.file)!;
    questions.push({ kind: 'test', test, text: redact(`Can the diff change what the e2e test "${test.titlePath.join(' > ')}" in ${key} checks? ${fileOf(key)}, hooks included.`) });
  }
  for (const file of setups) {
    const { key, questions } = found.get(file)!;
    questions.push({ kind: 'setup', file, text: `Can the diff break the e2e setup in ${key}, or the session it saves for the tests that use it? ${fileOf(key)}.` });
  }
  return [...found.values()];
}
/**
 * Packs the subjects into calls that each stay within `MAX_STATE_BYTES`
 * with the diff and ask at most `MAX_QUESTIONS`, splitting a subject's
 * questions across calls where they are more. Two subjects whose keys are
 * the same, as two paths that redact alike, go to separate calls, so
 * neither replaces the other. A subject too large to send with the diff is
 * set apart.
 */
function pack(found: readonly Subject[], diffBytes: number): { readonly batches: Batch[]; readonly tooLarge: Subject[] } {
  const batches: Batch[] = [];
  const tooLarge: Subject[] = [];
  let room = 0;
  for (const subject of found) {
    if (diffBytes + subject.bytes > MAX_STATE_BYTES) {
      tooLarge.push(subject);
      continue;
    }
    for (let start = 0; start < subject.questions.length; start += MAX_QUESTIONS) {
      const chunk = subject.questions.slice(start, start + MAX_QUESTIONS);
      const last = batches.at(-1);
      if (last === undefined || Object.hasOwn(last.testFiles, subject.key) || subject.bytes > room || last.questions.length + chunk.length > MAX_QUESTIONS) {
        batches.push({ testFiles: { [subject.key]: subject.text }, questions: chunk });
        room = MAX_STATE_BYTES - diffBytes - subject.bytes;
      } else {
        last.testFiles[subject.key] = subject.text;
        last.questions.push(...chunk);
        room -= subject.bytes;
      }
    }
  }
  return { batches, tooLarge };
}
/**
 * Makes one call per batch, `CONCURRENCY` at a time. A failed call's
 * questions stay unanswered; once `MAX_FAILURES` calls have failed, the
 * calls in flight stop and no more start. Resolves to the answers, what
 * the calls that answered spent, and the failures.
 */
async function askAll(
  batches: readonly Batch[],
  diff: string,
  options: DecisionFilterOptions,
  signal: AbortSignal,
): Promise<{ readonly answers: Answers; readonly spend: Spend; readonly failures: readonly unknown[] }> {
  const stop = new AbortController();
  const abortSignal = AbortSignal.any([signal, stop.signal]);
  const answers: Answers = { tests: new Map(), setups: new Map() };
  const spend: Spend = { calls: 0, tokens: 0, costUsd: undefined, uncosted: false };
  const failures: unknown[] = [];
  let next = 0;
  const work = async (): Promise<void> => {
    for (let batch = batches[next++]; batch !== undefined && !stop.signal.aborted; batch = batches[next++]) {
      try {
        const { probabilities, usage, providerMetadata } = await decideBooleans(
          options,
          { diff, testFiles: batch.testFiles },
          Object.fromEntries(batch.questions.map((question, i) => [`t${i}`, question.text])),
          abortSignal,
        );
        batch.questions.forEach((question, i) => {
          const probability = probabilities[`t${i}`] ?? 1;
          if (question.kind === 'test') answers.tests.set(question.test.id, probability);
          else answers.setups.set(question.file, probability);
        });
        const cost = readCost(providerMetadata);
        spend.calls += 1;
        spend.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (cost === undefined) spend.uncosted = true;
        else spend.costUsd = (spend.costUsd ?? 0) + cost;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        // A call the stop cut short is not a failure of its own.
        if (stop.signal.aborted) return;
        failures.push(error);
        if (failures.length >= MAX_FAILURES) stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, work));
  return { answers, spend, failures };
}
/** The filter's answer: `exclude`, and a note of each of `problems` given, then what the calls spent, such as `11 calls, 307.6k tokens, $0.0129`, its cost only when every call reported one. */
function answered(exclude: Record<string, string>, problems: readonly (string | undefined)[], { calls, tokens, costUsd, uncosted }: Spend): TestFilterResult {
  const cost = costUsd === undefined || uncosted ? '' : `, ${formatCost(costUsd)}`;
  const spent = calls === 0 ? undefined : `${counted(calls, 'call')}, ${formatTokens(tokens)} tokens${cost}`;
  const note = [...problems, spent].filter((part) => part !== undefined).join('; ');
  return note === '' ? { exclude } : { exclude, note };
}
/**
 * One call's cost in USD, where the provider reports it. The Vercel AI
 * Gateway's `cost` is what it bills; a route on the user's own provider key
 * reports `cost: "0"`, so `marketCost`, the list price, stands in.
 */
function readCost(metadata: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined): number | undefined {
  const usd = (raw: unknown): number | undefined => {
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const billed = usd(metadata?.['gateway']?.['cost']);
  if (billed !== undefined && billed > 0) return billed;
  return usd(metadata?.['gateway']?.['marketCost']) ?? billed;
}
/** A token count: plain under a thousand, then `12.4k`, then `4.2M`. */
function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
/** USD with enough precision for sub-cent calls; `<$0.0001` for a cost that would round to nothing. */
function formatCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.00005) return '<$0.0001';
  return `$${costUsd.toFixed(costUsd < 0.1 ? 4 : 2)}`;
}
/** How a question points the model at the file it is about, by its key in `testFiles`. */
function fileOf(key: string): string {
  return `testFiles[${JSON.stringify(key)}] is its file`;
}
/** Tests as a note counts them: `3 tests in 2 files`. */
function testsIn(tests: readonly TestFilterCandidate[]): string {
  return `${counted(tests.length, 'test')} in ${counted(new Set(tests.map((test) => test.file)).size, 'file')}`;
}
/**
 * The change as one unified diff of `changes.files`, with renames found and
 * a deleted file's lines left out: what the commits since `changes.base`
 * change, never the working tree, then each file no commit changes by name
 * alone, since CI may have written it. Stops adding
 * files once the diff is past `MAX_DIFF_BYTES`.
 */
async function changeDiff({ base, root, files }: TestFilterChanges, signal: AbortSignal): Promise<string> {
  const committed = new Set((await git(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base, 'HEAD', '--'], signal)).split('\0'));
  let diff = '';
  for (const paths of pathspecs(files.filter((file) => committed.has(file)))) {
    diff += await git(root, ['--literal-pathspecs', 'diff', ...DIFF_FLAGS, '-M', '--irreversible-delete', base, 'HEAD', '--', ...paths], signal);
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) return diff;
  }
  for (const file of files) {
    if (committed.has(file)) continue;
    diff += `diff --git ${diffPath(`a/${file}`)} ${diffPath(`b/${file}`)}\nnot committed, contents not read\n`;
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) break;
  }
  return diff;
}
/** A path as a diff header names it: quoted, as git quotes one, when it holds a quote, a backslash, or a control character, so a name can't add lines of its own. */
function diffPath(file: string): string {
  return /["\\\p{Cc}]/u.test(file) ? JSON.stringify(file) : file;
}
/** `files` in runs whose paths together stay within `MAX_PATHSPEC_CHARS`, one `git diff` each. */
function pathspecs(files: readonly string[]): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let chars = 0;
  for (const file of files) {
    if (run.length > 0 && chars + file.length > MAX_PATHSPEC_CHARS) {
      runs.push(run);
      run = [];
      chars = 0;
    }
    run.push(file);
    chars += file.length + 1;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}
/** What `git` prints in `cwd`. */
async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return (await exec('git', args, { cwd, signal, maxBuffer: MAX_DIFF_BUFFER, windowsHide: true })).stdout;
}
/** `count` and `noun`, plural unless the count is 1. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
/** The first non-empty line of what `error` says. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return line === undefined ? (error instanceof Error ? error.name : 'an unknown error') : line.trim();
}
