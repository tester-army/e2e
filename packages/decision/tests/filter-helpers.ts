import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestFilterCandidate, TestFilterContext } from 'e2e';
import { onTestFinished } from 'vitest';
import type { DecisionFilterOptions } from '../src/index.ts';

type DecisionModel = DecisionFilterOptions['model'];
type Decider = Extract<DecisionModel, { doDecide: unknown }>;
type DecideCall = Parameters<Decider['doDecide']>[0];
type DecideResult = Awaited<ReturnType<Decider['doDecide']>>;

/** One decide call as the model saw it: the JSON state, each question's instructions by id, the signal, and the provider options. */
export interface DecideRequest {
  readonly state: unknown;
  readonly instructions: Readonly<Record<string, string>>;
  readonly abortSignal: AbortSignal | undefined;
  readonly providerOptions: DecideCall['providerOptions'];
}

/**
 * A scripted decision model: answers every boolean question with the
 * probability `resolve` gives its instructions, and records each call. Each
 * call first awaits `before`, given its index from 0 and its request; a
 * throw there fails the call. Each answer reports `inputTokens` and, when
 * given, `providerMetadata`.
 */
export function scriptedJudge(
  resolve: (instructions: string) => number,
  before?: (call: number, request: DecideRequest) => void | Promise<void>,
  { inputTokens = 10, providerMetadata }: { readonly inputTokens?: number; readonly providerMetadata?: DecideResult['providerMetadata'] } = {},
): { model: DecisionModel; requests: DecideRequest[] } {
  const requests: DecideRequest[] = [];
  const model: Decider = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted-judge',
    supportedQuestionTypes: ['boolean'],
    async doDecide(call: DecideCall): Promise<DecideResult> {
      const json = call.state.find((part) => part.type === 'json');
      const instructions = Object.fromEntries(Object.entries(call.questions).map(([id, question]) => [id, String(question.instructions)]));
      const request = { state: json?.type === 'json' ? json.value : undefined, instructions, abortSignal: call.abortSignal, providerOptions: call.providerOptions };
      requests.push(request);
      await before?.(requests.length - 1, request);
      const answers = Object.fromEntries(Object.entries(instructions).map(([id, text]) => [id, { type: 'boolean' as const, probability: resolve(text) }]));
      return { answers, warnings: [], usage: { inputTokens, outputTokens: 0 }, response: { modelId: 'scripted-judge' }, ...(providerMetadata === undefined ? {} : { providerMetadata }) };
    },
  };
  return { model, requests };
}

/** Runs git in `cwd` with the user's and the system's config shut out. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.test',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.test',
    },
  }).trim();
}

/** Writes `files`, by path relative to `root`. */
function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** A repository holding a change, and where its e2e project is. */
export interface ChangedRepo {
  readonly root: string;
  readonly projectRoot: string;
  readonly base: string;
  readonly files: readonly string[];
}

/**
 * A repository in the temp directory with `base` committed and `change`
 * written over it uncommitted, both by repository-relative path, removed
 * when the test finishes. The e2e project is at the root, or at `project`
 * inside it; `config` is set in the repository's own git config.
 */
export function changedRepo(
  base: Readonly<Record<string, string>>,
  change: Readonly<Record<string, string>>,
  { project = '.', config = {} }: { readonly project?: string; readonly config?: Readonly<Record<string, string>> } = {},
): ChangedRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-decision-filter-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet');
  for (const [key, value] of Object.entries(config)) git(root, 'config', key, value);
  writeFiles(root, base);
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'base');
  writeFiles(root, change);
  return { root, projectRoot: path.join(root, project), base: git(root, 'rev-parse', 'HEAD'), files: Object.keys(change).toSorted() };
}

/** Commits every change in `repo`, as a pull request's branch holds it, and returns the commit. */
export function commitAll(repo: ChangedRepo): string {
  git(repo.root, 'add', '--all');
  git(repo.root, 'commit', '--quiet', '-m', 'change');
  return git(repo.root, 'rev-parse', 'HEAD');
}

/** A secret every context's `redact` replaces. */
export const SECRET = 'sk-test-4f9c2b7e1d';

/** A secret spanning lines, as a private key does, that every context's `redact` replaces. */
export const PRIVATE_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
  '-----END PRIVATE KEY-----',
].join('\n');

/** A filter context for `repo`; `log` lines land in `logs`. */
export function filterContext(repo: ChangedRepo): { context: TestFilterContext; logs: string[] } {
  const logs: string[] = [];
  const context: TestFilterContext = {
    projectRoot: repo.projectRoot,
    changes: { base: repo.base, root: repo.root, files: repo.files },
    signal: new AbortController().signal,
    log: (line) => {
      logs.push(line);
    },
    redact: (text) => text.replaceAll(PRIVATE_KEY, '[redacted]').replaceAll(SECRET, '[redacted]'),
  };
  return { context, logs };
}

/** The candidate for the test at `titlePath` in `file`, with the id the runner gives it. */
export function candidate(file: string, ...titlePath: string[]): TestFilterCandidate {
  return { id: `${file}::${titlePath.join('::')}`, file, titlePath, tags: [] };
}

/** `test` with its session saved by the setup test in `setupFile`. */
export function withSetup(test: TestFilterCandidate, setupFile: string): TestFilterCandidate {
  return { ...test, setupFile };
}
