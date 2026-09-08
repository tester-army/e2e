/**
 * The project half of `e2e mcp`: what a coding agent does around the tests
 * themselves. Lists what `e2e list` would, runs a selection through the same
 * `run()` the CLI uses while streaming its events as progress, and reads a
 * finished run back as a digest. Nothing here touches a live app.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverConfig } from '../config/load.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { Report1Document } from '../report/build.ts';
import type { RunEvent } from '../run/events.ts';
import { formatListedPair, list, run, type RunOptions } from '../run/runner.ts';
import { digestReport } from './digest.ts';

export interface ProjectOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface ListTestsInput {
  readonly files?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly target?: string | undefined;
}

/**
 * The selection `e2e list` prints, grouped per file. An empty selection is
 * the runner's own NO_TESTS error, which names the positional or glob that
 * matched nothing and any file that looks like a test but does not match.
 */
export async function listTests(options: ProjectOptions, input: ListTestsInput): Promise<string> {
  const { pairs } = await list({
    cwd: options.cwd,
    configPath: options.configPath,
    env: options.env,
    files: input.files,
    tags: input.tags,
    targetIds: input.target === undefined ? undefined : [input.target],
  });
  const runnable = pairs.filter((pair) => pair.disposition === 'run').length;
  const files = new Set(pairs.map((pair) => pair.file));
  const lines = [`# Tests`, '', `${pairs.length} test-target pairs in ${files.size} files; ${runnable} would run, ${pairs.length - runnable} are skipped.`];
  for (const file of files) {
    lines.push('', `## ${file}`, '');
    for (const pair of pairs.filter((candidate) => candidate.file === file)) {
      lines.push(`- ${formatListedPair(pair).slice(file.length + 3)}`);
    }
  }
  return lines.join('\n');
}

export interface RunTestsInput {
  readonly files?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly tagMode?: 'any' | 'all' | undefined;
  readonly target?: string | undefined;
  readonly headed?: boolean | undefined;
  readonly noCache?: boolean | undefined;
  readonly retries?: number | undefined;
  readonly workers?: number | undefined;
}

export interface RunTestsHooks {
  /** One line of progress, in event order. */
  readonly progress: (message: string) => void;
  readonly signal: AbortSignal;
}

export interface RunTestsOutcome {
  readonly text: string;
  readonly exitCode: number;
}

/** Runs a selection through the runner and returns the digest of its report. */
export async function runTests(options: ProjectOptions, input: RunTestsInput, hooks: RunTestsHooks): Promise<RunTestsOutcome> {
  const runOptions: RunOptions = {
    cwd: options.cwd,
    configPath: options.configPath,
    env: options.env,
    files: input.files,
    tags: input.tags,
    tagMode: input.tagMode,
    targetIds: input.target === undefined ? undefined : [input.target],
    headed: input.headed,
    noCache: input.noCache,
    retries: input.retries,
    workers: input.workers,
    quiet: true,
    interruptSignal: hooks.signal,
    onEvent: (event) => {
      const line = describeEvent(event);
      if (line !== undefined) hooks.progress(line);
    },
  };
  const outcome = await run(runOptions);
  // The report sits at <projectRoot>/.e2e/report.json; without one, the
  // config's discovery says where the project root is.
  const projectRoot =
    outcome.reportPath === undefined
      ? discoverConfig(options.cwd, options.configPath).projectRoot
      : path.dirname(path.dirname(outcome.reportPath));
  const artifactsRoot = path.join(projectRoot, '.e2e', 'artifacts');
  const digest = digestReport(outcome.report, {
    artifactsRoot,
    ...(outcome.reportPath === undefined ? {} : { reportPath: outcome.reportPath }),
  });
  return { text: digest, exitCode: outcome.exitCode };
}

/** One progress line per event worth relaying; undefined for the rest. */
function describeEvent(event: RunEvent): string | undefined {
  switch (event.type) {
    case 'plan':
      return `Planned ${event.total} test-target pairs across ${event.files.length} file-target blocks.`;
    case 'notice':
      return `${event.target}: ${event.message}`;
    case 'test-started':
      return `Started ${event.title} on ${event.target}`;
    case 'test-finished': {
      const result = event.result;
      const title = result.test.titlePath.join(' › ');
      const attempt = result.attempts.at(-1);
      const error = attempt?.error === undefined ? '' : ` — ${attempt.error.code}: ${attempt.error.message}`;
      return `${result.status}: ${title} on ${event.result.target.name}${error}`;
    }
    case 'run-error':
      return `Run error ${event.error.code}: ${event.error.message}`;
    case 'run-interrupted':
      return `Run interrupted (${event.mode}).`;
    case 'run-finished':
      return `Run ${event.status} (exit ${event.exitCode}).`;
    default:
      return undefined;
  }
}

export interface ReadReportInput {
  readonly path?: string | undefined;
}

/** Reads a report from disk, the latest one by default, and digests it. */
export async function readReport(options: ProjectOptions, input: ReadReportInput): Promise<string> {
  let reportPath: string;
  let artifactsRoot: string;
  if (input.path !== undefined) {
    reportPath = path.resolve(options.cwd, input.path);
    artifactsRoot = path.join(path.dirname(reportPath), 'artifacts');
  } else {
    const discovered = discoverConfig(options.cwd, options.configPath);
    reportPath = path.join(discovered.projectRoot, '.e2e', 'report.json');
    artifactsRoot = path.join(discovered.projectRoot, '.e2e', 'artifacts');
  }
  if (!existsSync(reportPath)) {
    throw new ConfigurationError('REPORT_NOT_FOUND', `no report at ${reportPath}; run the tests first (run_tests), or pass the path of a report.json`);
  }
  const document = parseReport(reportPath);
  return digestReport(document, { artifactsRoot, reportPath });
}

/** Reads a report file; a missing or foreign document is an error the agent can act on. */
function parseReport(reportPath: string): Report1Document {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (cause) {
    throw new ConfigurationError('REPORT_INVALID', `${reportPath} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { schemaVersion?: unknown }).schemaVersion !== 'report-1') {
    throw new ConfigurationError('REPORT_INVALID', `${reportPath} is not an e2e report-1 document`);
  }
  return parsed as Report1Document;
}
