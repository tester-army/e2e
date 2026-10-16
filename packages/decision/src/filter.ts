import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestFilter, TestFilterCandidate, TestFilterChanges, TestFilterContext, TestFilterResult } from 'e2e';
import { ConfigurationError } from 'e2e/engine';
import { decideBooleans, requireDecide } from './decide.ts';
import { checkModel } from './model.ts';
import type { DecisionFilterOptions } from './types.ts';
const exec = promisify(execFile);
/** A test the model rates less likely than this to be affected is left out. */
const MIN_PROBABILITY = 0.2;
/** Most characters of state, the diff and test files, one call sends: Jev takes 32k tokens of state and a question, about 3.4 characters a token. */
const MAX_STATE_CHARS = 80_000;
/** A longer diff is not sent, and the filter leaves nothing out: each call keeps room for test files. */
const MAX_DIFF_CHARS = 60_000;
/** Most questions one call asks. */
const MAX_QUESTIONS = 200;
/** Most calls in flight at once. */
const CONCURRENCY = 8;
/** What `git diff` may print, far past MAX_DIFF_CHARS so a long diff is measured rather than lost. */
const MAX_DIFF_BUFFER = 64 * 1024 * 1024;
/** A line inside a hunk: context, removed, added, or the marker of a missing newline at the end of a file. */
const HUNK_LINE = /^[ +\-\\]/;
/** How a valid model reads, for every model error. */
const EXAMPLE = "pass an AI SDK decision model, e.g. decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })";
type Model = DecisionFilterOptions['model'];
type Redact = TestFilterContext['redact'];
/**
 * A test filter named `decision` that asks the decision model, test by
 * test, whether the change can affect what it checks, and leaves out the
 * unlikely ones.
 */
export function decisionFilter(options: DecisionFilterOptions): TestFilter {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigurationError('INVALID_CONFIG', `decisionFilter() takes an options object; ${EXAMPLE}`);
  }
  requireDecide('decisionFilter');
  checkModel(options.model, { caller: 'decisionFilter', questionType: 'boolean', example: EXAMPLE });
  const { model } = options;
  return {
    name: 'decision',
    filter: (tests, context) => judge(tests, context, model),
  };
}
/** Test files that go to the model in one call, by path, and the tests asked about. */
interface Batch {
  readonly testFiles: Record<string, string>;
  readonly tests: TestFilterCandidate[];
}
/** What the calls that answered spent: how many, their tokens, and their cost in USD when the provider reports one. */
interface Spend {
  calls: number;
  tokens: number;
  costUsd: number | undefined;
}
/**
 * Asks the model about the tests in batches of test files, one boolean
 * question per test and at most `MAX_QUESTIONS` a call, against the redacted
 * diff and the redacted files, `CONCURRENCY` calls at a time. An error other than the run's abort stops
 * the calls and keeps what the batches already judged left out. The note
 * names what the model did not judge, and what the calls spent.
 */
async function judge(
  tests: readonly TestFilterCandidate[],
  { projectRoot, changes, signal, log, redact }: TestFilterContext,
  model: Model,
): Promise<TestFilterResult> {
  const files = byFile(tests);
  log(`asking ${model.modelId} about ${counted(tests.length, 'test')} in ${counted(files.size, 'file')}`);
  const exclude: Record<string, string> = {};
  const tooLarge: string[] = [];
  const spend: Spend = { calls: 0, tokens: 0, costUsd: undefined };
  const judged = new Set<string>();
  try {
    const stdout = await changeDiff(changes, signal);
    if (stdout.length > MAX_DIFF_CHARS) return { exclude: {}, note: `the diff is over ${MAX_DIFF_CHARS} characters, so the decision filter left nothing out` };
    const diff = redactDiff(stdout, redact);
    const batches: Batch[] = [];
    let room = 0;
    for (const [file, fileTests] of files) {
      const text = redact(await readFile(path.join(projectRoot, file), { encoding: 'utf8', signal }));
      const key = redact(file);
      if (diff.length + text.length > MAX_STATE_CHARS) {
        tooLarge.push(file);
        continue;
      }
      for (let start = 0; start < fileTests.length; start += MAX_QUESTIONS) {
        const chunk = fileTests.slice(start, start + MAX_QUESTIONS);
        const last = batches.at(-1);
        // Two paths can redact to one key: they go to separate calls, so neither file replaces the other.
        if (last === undefined || key in last.testFiles || text.length > room || last.tests.length + chunk.length > MAX_QUESTIONS) {
          batches.push({ testFiles: { [key]: text }, tests: chunk });
          room = MAX_STATE_CHARS - diff.length - text.length;
        } else {
          last.testFiles[key] = text;
          last.tests.push(...chunk);
          room -= text.length;
        }
      }
    }
    // Aborted once a call fails, so the calls in flight beside it stop too.
    const stop = new AbortController();
    const abortSignal = AbortSignal.any([signal, stop.signal]);
    let failure: { readonly error: unknown } | undefined;
    let next = 0;
    const work = async (): Promise<void> => {
      for (let batch = batches[next++]; batch !== undefined && failure === undefined; batch = batches[next++]) {
        try {
          const { probabilities, usage, providerMetadata } = await decideBooleans(
            model,
            { diff, testFiles: batch.testFiles },
            Object.fromEntries(batch.tests.map((test, i) => [`t${i}`, redact(question(test))])),
            abortSignal,
          );
          batch.tests.forEach((test, i) => {
            const probability = probabilities[`t${i}`] ?? 1;
            if (probability < MIN_PROBABILITY) exclude[test.id] = `${Math.round(probability * 100)}% likely affected`;
          });
          const cost = readCost(providerMetadata);
          spend.calls += 1;
          spend.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          if (cost !== undefined) spend.costUsd = (spend.costUsd ?? 0) + cost;
          for (const test of batch.tests) judged.add(test.id);
        } catch (error) {
          failure ??= { error };
          stop.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, work));
    if (failure !== undefined) throw failure.error;
  } catch (error) {
    // The runner tells an interrupt from its own deadline by the reason.
    if (signal.aborted) throw signal.reason;
    return answered(exclude, `${model.modelId} did not judge ${unjudged(tests, judged)}: ${firstLine(error)}`, spend);
  }
  if (tooLarge.length === 0) return answered(exclude, undefined, spend);
  const what = tooLarge.length === 1 ? `${tooLarge[0]} is` : `${counted(tooLarge.length, 'file')} are`;
  return answered(exclude, `${model.modelId} did not judge ${unjudged(tests, judged)}: ${what} too large to send with the diff`, spend);
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
/** What the model is asked about `test`. */
function question(test: TestFilterCandidate): string {
  return `Can the diff change what the e2e test "${test.titlePath.join(' > ')}" in ${test.file} checks? testFiles[${JSON.stringify(test.file)}] is its file, hooks included.`;
}
/** The tests the model did not judge, as a note counts them: `3 tests in 2 files`. */
function unjudged(tests: readonly TestFilterCandidate[], judged: ReadonlySet<string>): string {
  const missed = tests.filter((test) => !judged.has(test.id));
  return `${counted(missed.length, 'test')} in ${counted(new Set(missed.map((test) => test.file)).size, 'file')}`;
}
/**
 * The change as one unified diff: the working tree against `changes.base`,
 * then each untracked file the runner counts, as a new file. Stops adding
 * files once the diff is past `MAX_DIFF_CHARS`.
 */
async function changeDiff({ base, root }: TestFilterChanges, signal: AbortSignal): Promise<string> {
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
  let diff = await git(root, ['diff', ...flags, base, '--'], signal);
  for (const file of (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0')) {
    if (diff.length > MAX_DIFF_CHARS) break;
    // An untracked nested repository is listed as its directory, and is not this repository's change.
    if (file === '' || file.endsWith('/')) continue;
    diff += await git(root, ['diff', '--no-index', ...flags, '--', '/dev/null', file], signal);
  }
  return diff;
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
/** The tests grouped by file, the files in the order their first test comes. */
function byFile(tests: readonly TestFilterCandidate[]): Map<string, TestFilterCandidate[]> {
  const files = new Map<string, TestFilterCandidate[]>();
  for (const test of tests) {
    const group = files.get(test.file);
    if (group === undefined) files.set(test.file, [test]);
    else group.push(test);
  }
  return files;
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
