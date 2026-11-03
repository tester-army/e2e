/**
 * The `run_tests` tool: `e2e run` from the MCP server, so a coding agent that
 * only has the server can run a test file or the whole suite. The run is the
 * CLI's own, in a child process of the same e2e: its workers, app commands,
 * reporters, cache, and report are exactly what `npx e2e run` gives, and
 * nothing it loads or prints shares the server's registries or the protocol
 * stream. The result is what the list reporter printed, the text an agent
 * reads after running the CLI. One run at a time: two would share the
 * report, the results directory, and the app's port.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXIT_CODES } from '../cli/exit-codes.ts';
import { ConfigurationError, InfrastructureError } from '../internal/errors.ts';
import { MAX_TIMER_MS } from '../internal/time.ts';
import { defineMcpTool, redacting, type McpToolResult, type McpToolSpec } from './tools.ts';

/** How long each rung of the CLI's Ctrl-C ladder (interrupt, force, exit) waits before the next, and the kill after the last. */
const ESCALATE_MS = 15_000;
/** How much of the run's output a result keeps: the end, where the failures and the summary are. */
const MAX_OUTPUT_CHARS = 60_000;
/** The longest progress message; the rest of a longer line is dropped from the notification, not from the result. */
const MAX_PROGRESS_CHARS = 1_000;

export interface TestRunsOptions {
  /** Where the run starts, as `npx e2e run` would from the server's working directory. */
  readonly cwd: string;
  /** The config a run loads unless the call names one, from `e2e mcp --config`. */
  readonly configPath?: string | undefined;
  /** The target a run is narrowed to unless the call names some, from `e2e mcp --target`. */
  readonly target?: string | undefined;
  /** Whether a run shows its UI when the call does not say, from `e2e mcp --headed`. */
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
}

const name = z.string().min(1);
const count = (min: number) => z.number().int().min(min).max(MAX_TIMER_MS);

const RunTestsArgs = z
  .object({
    files: z
      .array(name.refine((file) => !file.startsWith('-'), 'a file cannot start with "-"; flags are the other fields'))
      .optional()
      .describe('What e2e run takes as positionals: files, directories, quoted globs, or file:line for the test declared on that line (tests/checkout.e2e.ts:12). Default: every test the config discovers'),
    config: name.optional().describe("Path to an e2e config file, absolute or relative to the server's working directory; default: the server's --config, else the nearest e2e.config.ts"),
    target: z.array(name).min(1).optional().describe("Target names to run on; default: the server's --target, else every target"),
    grep: name.optional().describe('Only tests whose title (describe titles and test title, space-joined) matches this regular expression'),
    grepInvert: name.optional().describe('Leave out tests whose title matches this regular expression'),
    tag: z.array(name).optional().describe('Only tests carrying any of these tags'),
    excludeTag: z.array(name).optional().describe('Leave out tests carrying any of these tags'),
    lastFailed: z.boolean().optional().describe('Only the tests the previous run did not pass'),
    changedSince: name.optional().describe('Run the configured test filters on what differs from this git ref, such as origin/main'),
    headed: z.boolean().optional().describe('Show the browser or simulator while tests run, when the engine supports it; default: headless, unless the server was started with --headed'),
    workers: count(0).optional().describe('Parallel workers; default: from the config'),
    retries: count(0).optional().describe('Retries per failing test; default: from the config. 0 while fixing a test'),
    repeatEach: count(1).optional().describe('Run every selected test this many times, to measure a flaky one'),
    maxFailures: count(1).optional().describe('Stop the run once this many tests have failed'),
    actionTimeout: count(1).optional().describe('Milliseconds each engine operation may take, such as a locator waiting for its element; 5000 while fixing a test'),
    noCache: z.boolean().optional().describe('Run with the replay cache off, so every agent step calls the model'),
    updateSnapshots: z.boolean().optional().describe('Write the stored screenshots toHaveScreenshot finds missing or different, and pass'),
  })
  .strict();

type RunTestsInput = z.infer<typeof RunTestsArgs>;

/** Runs the project's tests through the CLI, one run at a time, until the server closes. */
export class TestRuns {
  private running: RunProcess | undefined;
  private closed = false;

  constructor(private readonly options: TestRunsOptions) {}

  /** The `run_tests` tool, redacting what it returns like the session tools. */
  toolSpec(): McpToolSpec {
    return redacting(
      defineMcpTool({
        name: 'run_tests',
        description:
          'Run tests as npx e2e run does and return what it printed: each test, the failures with their code frames, and the summary. Without files it runs every test the config discovers; files narrows to a test file, a directory, a glob, or one test (tests/checkout.e2e.ts:12). The run is the CLI\'s own, in its own process, with its workers, retries, replay cache, and report (.e2e/report.json by default); it needs no open session and leaves open sessions alone. One run at a time; cancelling the call interrupts it as Ctrl-C would. To fix a failing test, open_session {test: "<file>:<line>"} stops on the screen where it failed.',
        inputSchema: RunTestsArgs,
        readOnly: false,
        call: (args, extra) => this.run(args, extra.signal, extra.progress),
      }),
    );
  }

  /** Refuses new runs, interrupts the one in flight, and waits for it to exit: the server is shutting down. */
  async stop(): Promise<void> {
    this.closed = true;
    const running = this.running;
    if (running === undefined) return;
    running.stop();
    await running.exited.catch(() => undefined);
  }

  private async run(args: RunTestsInput, signal: AbortSignal, progress: ((message: string) => void) | undefined): Promise<McpToolResult> {
    const argv = runArguments(args, this.options);
    this.admit();
    // A run whose call was cancelled is on its way out: the next one waits for it rather than failing.
    if (this.running?.stopping === true) {
      await this.running.exited.catch(() => undefined);
      this.admit();
    }
    if (this.running !== undefined) {
      throw new ConfigurationError('RUNNER_BUSY', 'run_tests is already running a suite; wait for its result, or cancel that call, before starting another');
    }
    if (signal.aborted) throw new InfrastructureError('CANCELLED', 'the run was cancelled before it started');
    const output = new RunOutput(progress);
    const running = new RunProcess(argv, this.options, output);
    this.running = running;
    const stop = (): void => running.stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const exitCode = await running.exited;
      return { content: [{ type: 'text', text: resultText(argv, exitCode, output.text()) }], ...(isRunFailure(exitCode) ? { isError: true } : {}) };
    } finally {
      signal.removeEventListener('abort', stop);
      this.running = undefined;
    }
  }

  private admit(): void {
    if (this.closed) throw new InfrastructureError('CANCELLED', 'the e2e mcp server is shutting down; run_tests starts no new run');
  }
}

/**
 * One `e2e run` child. On POSIX it leads its own process group, so the kill
 * at the end of the ladder also reaches its workers; the app commands it
 * started are groups of their own, which its third rung kills. The IPC
 * channel is the server's lifetime: a server that dies closes it, and the
 * CLI interrupts itself (`SignalLadder`).
 */
class RunProcess {
  /** Resolves once the child has exited and its output closed, with its exit code; a spawn failure rejects. */
  readonly exited: Promise<number | undefined>;
  private readonly child: ChildProcess;
  private rungs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(argv: readonly string[], options: TestRunsOptions, output: RunOutput) {
    const entry = cliEntry();
    const env: NodeJS.ProcessEnv = { ...options.env, NO_COLOR: '1' };
    delete env['FORCE_COLOR'];
    this.child = spawn(process.execPath, [...entry.execArgv, entry.path, ...argv], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    });
    // Decoded per stream, so a character split across two chunks stays whole.
    this.child.stdout?.setEncoding('utf8').on('data', (text: string) => output.write(text, true));
    this.child.stderr?.setEncoding('utf8').on('data', (text: string) => output.write(text, false));
    let spawned = false;
    this.child.once('spawn', () => {
      spawned = true;
    });
    const exited = new Promise<number | undefined>((resolve, reject) => {
      // An 'error' after the spawn is a signal that could not be sent: the child still runs, and the ladder carries on.
      this.child.on('error', (error) => {
        if (!spawned) reject(error);
      });
      this.child.once('close', (code, exitSignal) => resolve(code ?? (exitSignal === null ? undefined : 130)));
    });
    this.exited = exited.finally(() => clearTimeout(this.timer));
  }

  /** Whether a cancel or the server's shutdown has started interrupting the run. */
  get stopping(): boolean {
    return this.rungs > 0;
  }

  /** Climbs the CLI's Ctrl-C ladder, one rung per `ESCALATE_MS`, then kills the process group: a run stuck in synchronous code answers no signal. */
  stop(): void {
    if (this.rungs === 0) this.escalate();
  }

  private escalate(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.rungs += 1;
    const last = this.rungs > 3;
    this.signal(last ? 'SIGKILL' : 'SIGINT');
    if (!last) this.timer = setTimeout(() => this.escalate(), ESCALATE_MS);
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The `e2e run` arguments a call stands for: the options, the server's
 * defaults for what it left out, then `--` and the files, so no file can
 * read as a flag. A value goes in its option's own word (`--grep=-new`), so
 * no value can either.
 */
export function runArguments(args: RunTestsInput, defaults: Omit<TestRunsOptions, 'cwd' | 'env'>): string[] {
  const argv = ['run'];
  const option = (flag: string, value: string | number | undefined): void => {
    if (value !== undefined) argv.push(`--${flag}=${value}`);
  };
  const toggle = (flag: string, on: boolean | undefined): void => {
    if (on === true) argv.push(`--${flag}`);
  };
  option('config', args.config ?? defaults.configPath);
  for (const target of args.target ?? (defaults.target === undefined ? [] : [defaults.target])) option('target', target);
  option('grep', args.grep);
  option('grep-invert', args.grepInvert);
  for (const tag of args.tag ?? []) option('tag', tag);
  for (const tag of args.excludeTag ?? []) option('exclude-tag', tag);
  toggle('last-failed', args.lastFailed);
  option('changed-since', args.changedSince);
  toggle('headed', args.headed ?? defaults.headed);
  option('workers', args.workers);
  option('retries', args.retries);
  option('repeat-each', args.repeatEach);
  option('max-failures', args.maxFailures);
  option('action-timeout', args.actionTimeout);
  toggle('no-cache', args.noCache);
  toggle('update-snapshots', args.updateSnapshots);
  const files = args.files ?? [];
  return files.length === 0 ? argv : [...argv, '--', ...files];
}

/**
 * The CLI entry of this e2e, for both the dist (.js) and src (.ts, vitest)
 * layouts; from source, e2e's own loader is registered first, as for a
 * worker.
 */
function cliEntry(): { path: string; execArgv: string[] } {
  // A path to spawn, not an import: the CLI runs in its own process, so it is no cycle.
  // fallow-ignore-next-line circular-dependency
  const js = fileURLToPath(new URL('../cli/bin.js', import.meta.url));
  if (existsSync(js)) return { path: js, execArgv: [] };
  // fallow-ignore-next-line circular-dependency
  const ts = fileURLToPath(new URL('../cli/bin.ts', import.meta.url));
  return { path: ts, execArgv: ['--import', new URL('../config/register.ts', import.meta.url).href] };
}

/** Exit codes that mean the run itself went wrong, not a test: config, engine, internal, interrupted. */
function isRunFailure(exitCode: number | undefined): boolean {
  return exitCode !== 0 && exitCode !== 1;
}

/** The command line as a shell would take it, the exit code and its meaning, then the output. */
function resultText(argv: readonly string[], exitCode: number | undefined, output: string): string {
  const meaning = EXIT_CODES.find(([code]) => code === String(exitCode))?.[1];
  const exit = exitCode === undefined ? 'e2e run ended without an exit code' : `exit ${exitCode}${meaning === undefined ? '' : `: ${meaning}`}`;
  const printed = output.replace(/^\s*\n/, '').trimEnd();
  return [`e2e ${argv.map(shellWord).join(' ')}`, exit, '', printed === '' ? '(no output)' : printed].join('\n');
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * What the run printed, both streams in the order they arrived, with each
 * finished stdout line passed to `progress`, cut to `MAX_PROGRESS_CHARS`.
 * Only the end is kept once it outgrows a tool result: the failures and the
 * summary print last.
 */
class RunOutput {
  private kept = '';
  private cut = 0;
  /** The start of the stdout line still being written, bounded like a progress message. */
  private line = '';
  private lineFull = false;

  constructor(private readonly progress: ((message: string) => void) | undefined) {}

  write(text: string, stdout: boolean): void {
    this.kept += text;
    if (this.kept.length > MAX_OUTPUT_CHARS * 2) this.trim();
    if (stdout && this.progress !== undefined) this.feed(text);
  }

  text(): string {
    this.trim();
    if (this.cut === 0) return this.kept;
    return `… ${this.cut} earlier characters cut; the run's report.json under the config's output directory (.e2e by default) has every result.\n${this.kept}`;
  }

  private feed(text: string): void {
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      this.append(text.slice(start, end));
      const line = this.line.trim();
      if (line !== '') this.progress?.(this.lineFull ? `${line}…` : line);
      this.line = '';
      this.lineFull = false;
      start = end + 1;
    }
    this.append(text.slice(start));
  }

  private append(part: string): void {
    if (this.lineFull) return;
    this.line += part;
    if (this.line.length <= MAX_PROGRESS_CHARS) return;
    this.line = this.line.slice(0, MAX_PROGRESS_CHARS);
    this.lineFull = true;
  }

  /** Keeps the last `MAX_OUTPUT_CHARS` from a line start, or the bare tail when the last line alone is longer. */
  private trim(): void {
    if (this.kept.length <= MAX_OUTPUT_CHARS) return;
    const tail = this.kept.length - MAX_OUTPUT_CHARS;
    const newline = this.kept.indexOf('\n', tail);
    const from = newline === -1 || newline + 1 >= this.kept.length ? tail : newline + 1;
    this.cut += from;
    this.kept = this.kept.slice(from);
  }
}
