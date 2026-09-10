/**
 * Runs the matrix: every arm on every track, `repeats` times, a few runs at
 * a time, each in its own directory with its own app port. A run is the
 * e2e CLI spawned in the track's package with the model, port, and provider
 * options in the environment; what it leaves behind (report, AI trace,
 * artifacts, log, `run.json`) is what the scorer reads. One run failing to
 * start is one row of the matrix, never a lost matrix.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Arm } from './catalog.ts';
import { RUN_PROCESS_FILE, type RunProcess } from './score-run.ts';
import type { Track } from './tracks.ts';

/** Every run of a matrix gets a port from here up; well clear of the packages' fixed ports. */
const FIRST_PORT = 4400;
/** How long a run gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 15_000;

export interface PlannedRun {
  readonly arm: Arm;
  readonly track: Track;
  readonly repeat: number;
  readonly port: number;
  readonly dir: string;
}

export interface MatrixOptions {
  readonly root: string;
  readonly outDir: string;
  readonly arms: readonly Arm[];
  readonly tracks: readonly Track[];
  readonly repeats: number;
  readonly concurrency: number;
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
}

/**
 * Repeats outermost, arms innermost: the runs in flight at any moment are
 * different arms on the same track, so no provider sees several runs of one
 * model at once (the first matrix ran one arm's tracks together and the
 * newest model spent whole steps in rate-limit backoff), and a partial matrix
 * still compares every arm on the tracks it finished.
 */
export function planRuns(options: Pick<MatrixOptions, 'arms' | 'tracks' | 'repeats' | 'outDir'>): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    for (const track of options.tracks) {
      for (const arm of options.arms) {
        runs.push({
          arm,
          track,
          repeat,
          port: FIRST_PORT + runs.length,
          dir: path.join(options.outDir, arm.id, track.id, `r${String(repeat)}`),
        });
      }
    }
  }
  return runs;
}

/** What must exist before any run: the built CLI and the built web-benchmark app. */
export function checkPrerequisites(root: string): string[] {
  const missing: string[] = [];
  if (!existsSync(cliPath(root))) missing.push('the e2e CLI is not built: pnpm run build');
  if (!existsSync(path.join(root, 'packages/web-benchmark/app/.next'))) {
    missing.push('the web-benchmark app is not built: pnpm --filter @e2edev/web-benchmark run build');
  }
  return missing;
}

function cliPath(root: string): string {
  return path.join(root, 'packages/e2e/dist/cli/bin.js');
}

/** Runs the whole plan with bounded concurrency; resolves when every run has settled. */
export async function runMatrix(options: MatrixOptions): Promise<void> {
  const runs = planRuns(options);
  options.log(`${String(runs.length)} run(s), ${String(options.concurrency)} at a time, under ${options.outDir}`);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, runs.length) }, async () => {
      while (next < runs.length) {
        const run = runs[next]!;
        next += 1;
        await executeRun(run, options);
      }
    }),
  );
}

/** The CLI invocation for a planned run, for the log and for `--dry-run`. */
export function commandFor(run: PlannedRun, root: string): { readonly cwd: string; readonly args: string[] } {
  const { track } = run;
  const cwd = path.join(root, track.packageDir);
  const args = [cliPath(root), track.command];
  if (track.command === 'run') args.push(...(track.files ?? []));
  else args.push(track.goal ?? '');
  args.push('--config', track.config, '--artifacts', path.join(run.dir, 'artifacts'), '--ai-trace');
  if (track.command === 'run') args.push('--no-cache', '--retries', '0');
  args.push(...(track.args ?? []));
  return { cwd, args };
}

function environmentFor(run: PlannedRun, options: MatrixOptions): NodeJS.ProcessEnv {
  return {
    ...options.env,
    ...run.track.env,
    E2E_MODEL: run.arm.model,
    BENCH_PORT: String(run.port),
    ...(run.arm.providerOptions === undefined ? {} : { E2E_PROVIDER_OPTIONS: JSON.stringify(run.arm.providerOptions) }),
    // The repository's own runs are not usage, and colors would litter the log.
    E2E_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

async function executeRun(run: PlannedRun, options: MatrixOptions): Promise<void> {
  mkdirSync(run.dir, { recursive: true });
  const label = `${run.arm.id}/${run.track.id}/r${String(run.repeat)}`;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const { cwd, args } = commandFor(run, options.root);
  options.log(`start ${label} (port ${String(run.port)})`);
  const record = (process: Omit<RunProcess, 'startedAt' | 'durationMs'>): void => {
    const full: RunProcess = { ...process, startedAt, durationMs: Date.now() - started };
    writeFileSync(path.join(run.dir, RUN_PROCESS_FILE), `${JSON.stringify(full, null, 2)}\n`);
    options.log(
      `done  ${label}: exit ${String(full.exitCode)} in ${String(Math.round(full.durationMs / 1000))}s${full.error === undefined ? '' : ` (${full.error})`}`,
    );
  };
  try {
    const exitCode = await spawnCli(cwd, args, environmentFor(run, options), path.join(run.dir, 'cli.log'), run.track.timeoutMs);
    record(exitCode === null ? { exitCode: -1, error: `killed after ${String(run.track.timeoutMs / 60_000)} min` } : { exitCode });
  } catch (cause) {
    record({ exitCode: -1, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

/** Resolves to the exit code, or null when the run was killed at the track timeout. */
function spawnCli(cwd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile);
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      log.end();
      resolve(killed ? null : (code ?? -1));
    });
  });
}
