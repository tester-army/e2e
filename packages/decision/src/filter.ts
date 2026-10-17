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
/** A line inside a hunk: context, removed, added, or the marker of a missing newline at the end of a file. */
const HUNK_LINE = /^[ +\-\\]/;
/** How a valid model reads, for every model error. */
const EXAMPLE = "pass an AI SDK decision model, e.g. decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })";
type Redact = TestFilterContext['redact'];
/**
 * A test filter named `decision` that asks the decision model, test by
 * test, whether the change can affect what it checks, and whether it can
 * break the setup that saves the test's session, and leaves out the tests
 * unlikely on both counts.
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
    filter: (tests, context) => judge(tests, context, settings),
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
}
/** What the model answered, by test id and by setup file, as the probability of true. */
interface Answers {
  readonly tests: Map<string, number>;
  readonly setups: Map<string, number>;
}
/**
 * Asks the model about the tests, and the setup files that save their
 * sessions, against the redacted diff and the redacted files, in calls of
 * at most `MAX_QUESTIONS`, `CONCURRENCY` at a time. A test is left out when
 * both it and its setup are unlikely to be affected. A failed call leaves
 * its tests in, and after `MAX_FAILURES` no more calls are made. The note
 * names what the model did not judge, and what the calls spent.
 */
async function judge(tests: readonly TestFilterCandidate[], context: TestFilterContext, options: DecisionFilterOptions): Promise<TestFilterResult> {
  const { changes, signal, log, redact } = context;
  const { modelId } = options.model;
  log(`asking ${modelId} about ${counted(tests.length, 'test')} in ${counted(new Set(tests.map((test) => test.file)).size, 'file')}`);
  const spend: Spend = { calls: 0, tokens: 0, costUsd: undefined };
  const answers: Answers = { tests: new Map(), setups: new Map() };
  let tooLarge: readonly Subject[];
  let failures: readonly unknown[];
  try {
    const raw = await changeDiff(changes, signal);
    if (raw === '') return { exclude: {}, note: 'git printed no diff of the changed files, so the decision filter left nothing out' };
    if (Buffer.byteLength(raw) > MAX_DIFF_BYTES) return { exclude: {}, note: `the diff is over ${MAX_DIFF_BYTES / 1000} kB, so the decision filter left nothing out` };
    const diff = redactDiff(raw, redact);
    const packed = pack(await subjects(tests, context), Buffer.byteLength(diff));
    tooLarge = packed.tooLarge;
    failures = await askAll(packed.batches, diff, options, signal, answers, spend);
  } catch (error) {
    // An aborted call is one the run already stopped waiting for: it ends with the abort, not a note.
    if (signal.aborted) throw signal.reason;
    return answered({}, `${modelId} did not judge ${testsIn(tests)}: ${firstLine(error)}`, spend);
  }
  const exclude: Record<string, string> = {};
  const missed: TestFilterCandidate[] = [];
  for (const test of tests) {
    const own = answers.tests.get(test.id);
    const setup = test.setupFile === undefined ? 0 : answers.setups.get(test.setupFile);
    if (own === undefined || setup === undefined) missed.push(test);
    else if (Math.max(own, setup) < MIN_PROBABILITY) exclude[test.id] = `${Math.round(Math.max(own, setup) * 100)}% likely affected`;
  }
  if (missed.length === 0) return answered(exclude, undefined, spend);
  const what = tooLarge.length === 1 ? `${tooLarge[0]?.key} is` : `${counted(tooLarge.length, 'file')} are`;
  const why = [failures.length === 0 ? undefined : firstLine(failures[0]), tooLarge.length === 0 ? undefined : `${what} too large to send with the diff`];
  return answered(exclude, `${modelId} did not judge ${testsIn(missed)}: ${why.filter((part) => part !== undefined).join('; ')}`, spend);
}
/**
 * The files the model reads: each test file, then each setup file that
 * saves a test's session, keyed by their redacted path from the repository
 * root, as the diff names files, with their questions.
 */
async function subjects(tests: readonly TestFilterCandidate[], { projectRoot, changes, signal, redact }: TestFilterContext): Promise<Subject[]> {
  const found = new Map<string, Subject>();
  const subject = async (file: string): Promise<Subject> => {
    const known = found.get(file);
    if (known !== undefined) return known;
    const absolute = path.join(projectRoot, file);
    const text = redact(await readFile(absolute, { encoding: 'utf8', signal }));
    const created: Subject = { key: redact(path.relative(changes.root, absolute).split(path.sep).join('/')), text, bytes: Buffer.byteLength(text), questions: [] };
    found.set(file, created);
    return created;
  };
  for (const test of tests) {
    const { key, questions } = await subject(test.file);
    questions.push({ kind: 'test', test, text: redact(`Can the diff change what the e2e test "${test.titlePath.join(' > ')}" in ${key} checks? ${fileOf(key)}, hooks included.`) });
  }
  for (const file of new Set(tests.flatMap((test) => (test.setupFile === undefined ? [] : [test.setupFile])))) {
    const { key, questions } = await subject(file);
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
 * Makes one call per batch, `CONCURRENCY` at a time, recording each answer
 * in `answers` and what the call spent in `spend`. A failed call's
 * questions stay unanswered; once `MAX_FAILURES` calls have failed, the
 * calls in flight stop and no more start. Resolves to the failures.
 */
async function askAll(batches: readonly Batch[], diff: string, options: DecisionFilterOptions, signal: AbortSignal, answers: Answers, spend: Spend): Promise<unknown[]> {
  const stop = new AbortController();
  const abortSignal = AbortSignal.any([signal, stop.signal]);
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
        if (cost !== undefined) spend.costUsd = (spend.costUsd ?? 0) + cost;
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
  return failures;
}
/** The filter's answer: `exclude`, and a note of `problem`, if any, then what the calls spent, such as `11 calls, 307.6k tokens, $0.0129`. */
function answered(exclude: Record<string, string>, problem: string | undefined, { calls, tokens, costUsd }: Spend): TestFilterResult {
  const spent = calls === 0 ? undefined : `${counted(calls, 'call')}, ${formatTokens(tokens)} tokens${costUsd === undefined ? '' : `, ${formatCost(costUsd)}`}`;
  const note = [problem, spent].filter((part) => part !== undefined).join('; ');
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
/** USD with enough precision for sub-cent calls. */
function formatCost(costUsd: number): string {
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
 * a deleted file's lines left out: on a pull or merge request, `changes.head`
 * against `changes.base`; otherwise each tracked file in the working tree
 * against `changes.base`, then each untracked file as a new file. Stops
 * adding files once the diff is past `MAX_DIFF_BYTES`.
 */
async function changeDiff({ base, head, root, files }: TestFilterChanges, signal: AbortSignal): Promise<string> {
  const untracked = head === undefined ? new Set((await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0')) : new Set<string>();
  let diff = '';
  for (const paths of pathspecs(files.filter((file) => !untracked.has(file)))) {
    diff += await git(root, ['--literal-pathspecs', 'diff', ...DIFF_FLAGS, '-M', '--irreversible-delete', base, ...(head === undefined ? [] : [head]), '--', ...paths], signal);
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) return diff;
  }
  for (const file of files.filter((candidate) => untracked.has(candidate))) {
    diff += await git(root, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file], signal);
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) break;
  }
  return diff;
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
/**
 * What `git` prints in `cwd`. `git diff --no-index` exits 1 both when the
 * files differ, as a new file always does, and on an error, which prints no
 * diff.
 */
async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  try {
    return (await exec('git', args, { cwd, signal, maxBuffer: MAX_DIFF_BUFFER, windowsHide: true })).stdout;
  } catch (error) {
    if (args.includes('--no-index') && error instanceof Error && 'code' in error && error.code === 1 && 'stdout' in error && typeof error.stdout === 'string' && error.stdout !== '') {
      return error.stdout;
    }
    throw error;
  }
}
/**
 * `diff` with every secret `redact` finds replaced. A unified diff starts
 * each line of a hunk with ` `, `-`, or `+`, so a value spanning lines
 * never reads whole in it: each hunk is redacted side by side
 * (`redactHunk`), and the file headers between hunks as written.
 */
function redactDiff(diff: string, redact: Redact): string {
  const runs: { hunk: boolean; lines: string[] }[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) inHunk = false;
    else if (line.startsWith('@@ ')) inHunk = true;
    const hunk = inHunk && HUNK_LINE.test(line);
    const last = runs.at(-1);
    if (last?.hunk === hunk) last.lines.push(line);
    else runs.push({ hunk, lines: [line] });
  }
  return runs.map(({ hunk, lines }) => (hunk ? redactHunk(lines, redact) : redact(lines.join('\n')))).join('\n');
}
/**
 * One hunk's lines, redacted. Its old side (context and removed lines) and
 * its new side (context and added lines) are each redacted as the text
 * they are. When that matches redacting line by line, the lines keep their
 * places; otherwise a value spans lines, and the hunk becomes its redacted
 * old side removed, then its redacted new side added.
 */
function redactHunk(lines: readonly string[], redact: Redact): string {
  const sides = [hunkSide(lines, '-'), hunkSide(lines, '+')];
  if (sides.every(({ text }) => redact(text.join('\n')) === text.map(redact).join('\n'))) {
    return lines.map((line) => (line.startsWith('\\') ? line : `${line.charAt(0)}${redact(line.slice(1))}`)).join('\n');
  }
  return sides
    .flatMap(({ prefix, text, ending }) => (text.length === 0 ? [] : [...redact(text.join('\n')).split('\n').map((line) => `${prefix}${line}`), ...ending]))
    .join('\n');
}
/**
 * One side of a hunk: `-` for the old file, `+` for the new. Its text is
 * the context lines and the lines of its own prefix, without the prefixes;
 * its ending is the `\ No newline at end of file` line after its last line,
 * when the hunk has one.
 */
function hunkSide(lines: readonly string[], prefix: '-' | '+'): { prefix: '-' | '+'; text: string[]; ending: string[] } {
  const text: string[] = [];
  const ending: string[] = [];
  let mine = false;
  for (const line of lines) {
    if (line.startsWith('\\')) {
      if (mine) ending.push(line);
      continue;
    }
    mine = line.startsWith(' ') || line.startsWith(prefix);
    if (mine) text.push(line.slice(1));
  }
  return { prefix, text, ending };
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
