/** Spawned-process management for the app commands targets declare. */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Readiness } from '../config/command.ts';
import { InfrastructureError } from '../internal/errors.ts';
import { createRedactor } from '../internal/redact.ts';
import { sleep } from '../internal/time.ts';
import type { CommandConfig } from '../types.ts';

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC'] as const;

/** Readiness polling starts fast and backs off; a booting server answers late, not on a schedule. */
const READY_POLL_MIN_MS = 25;
const READY_POLL_MAX_MS = 250;
/** One readiness probe never outlives this, so a half-open server cannot stall the deadline check. */
const READY_PROBE_TIMEOUT_MS = 2_000;
/**
 * A wait past half its budget narrates once, so a stalled service is visible
 * while it stalls and not only 180 s later. Under this floor a short budget
 * stays quiet: half of it is not long enough to call a stall.
 */
const PROGRESS_NOTICE_MIN_MS = 5_000;
/** How much of the process's own output a startup failure quotes. */
const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_BYTES = 4_096;
/**
 * `command.env` values this long are redacted from the quoted output; shorter
 * ones (a port, a flag) would blank ordinary text without hiding anything.
 * The shared redactor has no floor of its own.
 */
const REDACTED_ENV_MIN_LENGTH = 4;

/** Every spawned process group still running, for the forced exit that cannot wait on `stop`. */
const live = new Set<ChildProcess>();

/**
 * Sends `signal` to the whole process group behind `child` (the child alone
 * on Windows, which has no process groups); a group already gone is fine.
 */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    // process already gone
  }
}

/** A leader exiting does not mean its descendants have left the process group. */
function processGroupRunning(child: ChildProcess): boolean {
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills every process group this module spawned and has not yet released,
 * synchronously and without waiting: the last resort before the process
 * exits on the spot, so nothing it started outlives it. A reused process was
 * never spawned here and is left alone.
 */
export function killManagedProcessGroups(): void {
  for (const child of live) signalProcessGroup(child, 'SIGKILL');
}

interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function describeExit(exit: ExitStatus): string {
  return exit.code === null ? `was terminated by ${exit.signal}` : `exited with code ${exit.code}`;
}

/** One readiness probe: true when `url` answers 200 through 499 within `timeoutMs`. */
async function answers(url: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { redirect: 'manual', signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
    return response.status >= 200 && response.status <= 499;
  } catch {
    return false;
  }
}

/**
 * What the runner tells a managed process about the run: whether CI mode is
 * active (where `reuseExisting` is ignored), where to narrate run-level
 * progress such as a reused app, and where to report the process starting
 * and becoming ready.
 */
export interface ManagedProcessHooks {
  readonly ci?: boolean;
  readonly notice?: (message: string) => void;
  readonly starting?: (label: string) => void;
  /** `reused` when the process attached to one already serving the URL instead of spawning. */
  readonly ready?: (label: string, durationMs: number, reused: boolean) => void;
}

/**
 * One command the runner owns: spawned as a process group, waited on until
 * its readiness contract holds, and terminated signal-then-force. `label`
 * names it in every error (`target "web" command`, `service "postgres"`).
 */
export class ManagedProcess {
  private child: ChildProcess | null = null;
  private reusedExisting = false;
  private spawnedProcess = false;

  constructor(
    private readonly label: string,
    private readonly command: CommandConfig,
    private readonly projectRoot: string,
    private readonly readiness: Readiness,
    private readonly hooks: ManagedProcessHooks = {},
  ) {}

  /**
   * True once `start` spawned a process: not when it attached to one already
   * serving the URL, found one there it may not reuse, or failed to spawn.
   */
  get spawned(): boolean {
    return this.spawnedProcess;
  }

  /**
   * Spawns the process group and waits for readiness. An already aborted
   * `signal` spawns nothing; one that aborts during the wait ends it early and
   * takes the process down with it. The caller reads the signal to learn the
   * run was interrupted.
   *
   * A readiness URL that already answers before the spawn belongs to a
   * process this run did not start, and HTTP readiness cannot tell which
   * process answered later. So the preflight probe decides up front: with
   * `reuseExisting` (outside CI) nothing is spawned and `stop` leaves the
   * process alone; otherwise the launch fails with `APP_ALREADY_RUNNING`
   * rather than letting the old server pass as the new command's readiness.
   * The probe spends from the same `startupTimeout` budget as the wait.
   */
  async start(signal?: AbortSignal): Promise<void> {
    // A function, not a narrowed local: the signal flips while `launch` awaits.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return;
    const startedAt = Date.now();
    this.hooks.starting?.(this.label);
    await this.launch(signal);
    if (!aborted()) this.hooks.ready?.(this.label, Date.now() - startedAt, this.reusedExisting);
  }

  /** The preflight probe, the spawn, and the readiness wait behind `start`. */
  private async launch(signal?: AbortSignal): Promise<void> {
    // A function, not a narrowed local: the signal flips while the loop awaits.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return;
    // Without a URL to probe, the process exiting 0 is the readiness event.
    const readyUrl = 'readyUrl' in this.readiness ? this.readiness.readyUrl : undefined;
    const startupTimeout = this.command.startupTimeout ?? 60_000;
    const deadline = Date.now() + startupTimeout;
    if (readyUrl !== undefined) {
      const reuse = this.command.reuseExisting === true && this.hooks.ci !== true;
      if (this.command.reuseExisting === true && !reuse) {
        this.hooks.notice?.(`${this.label}: reuseExisting is ignored in CI, starting the command`);
      }
      if (await answers(readyUrl, Math.min(READY_PROBE_TIMEOUT_MS, startupTimeout), signal)) {
        if (reuse) {
          this.reusedExisting = true;
          this.hooks.notice?.(`${this.label}: reusing the process already serving ${readyUrl}`);
          return;
        }
        throw new InfrastructureError(
          'APP_ALREADY_RUNNING',
          `${readyUrl} already answered before ${this.label} started; ${
            this.hooks.ci === true
              ? 'stop that process (reuseExisting is ignored in CI)'
              : 'stop that process or set reuseExisting: true'
          }`,
        );
      }
      if (aborted()) return;
    }
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.command.env ?? {});

    const logFd = this.openLog();
    // The log appends across commands and runs; a failure quotes what landed
    // past this offset. An earlier service still running on the same file
    // appends there too, which the quote's header admits.
    const logOffset = logFd === undefined ? undefined : fs.fstatSync(logFd).size;
    let child: ChildProcess;
    try {
      child = spawn(this.command.executable, [...(this.command.args ?? [])], {
        cwd: path.resolve(this.projectRoot, this.command.cwd ?? '.'),
        env,
        detached: process.platform !== 'win32',
        stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
      });
    } finally {
      // The child holds its own copy of the descriptor once spawn returns
      // (a spawn failure surfaces as the 'error' event, not here), so the
      // parent's copy would only be a leak for the life of the run.
      if (logFd !== undefined) fs.closeSync(logFd);
    }
    this.child = child;
    this.spawnedProcess = child.pid !== undefined;
    live.add(child);
    let spawnError: Error | undefined;
    child.on('error', (error) => {
      spawnError = error;
    });
    let exit: ExitStatus | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, exitSignal) => {
        exit = { code, signal: exitSignal };
        resolve();
      });
    });

    const half = startupTimeout / 2;
    let noticed = half < PROGRESS_NOTICE_MIN_MS;
    let pollMs = READY_POLL_MIN_MS;
    for (;;) {
      if (aborted()) {
        await this.stop();
        return;
      }
      if (spawnError !== undefined) {
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `${this.label} failed to start: ${spawnError.message}`,
          { cause: spawnError },
        );
      }
      if (exit !== undefined) {
        if (readyUrl === undefined && exit.code === 0) return;
        throw this.unreachable(
          `${this.label} ${describeExit(exit)} ${readyUrl === undefined ? 'instead of 0' : 'before becoming ready'}`,
          logOffset,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.stop();
        throw this.unreachable(
          readyUrl === undefined
            ? `${this.label} did not exit within ${startupTimeout} ms`
            : `${this.label} was not reachable at ${readyUrl} within ${startupTimeout} ms`,
          logOffset,
        );
      }
      if (!noticed && remaining <= half) {
        noticed = true;
        const waitingFor = readyUrl === undefined ? 'waiting for it to exit' : `waiting for ${readyUrl}`;
        const log = this.command.log === undefined ? '' : `; log: ${this.logDisplayPath()}`;
        this.hooks.notice?.(
          `${this.label} still starting after ${Math.round((startupTimeout - remaining) / 1000)}s: ${waitingFor}${log}`,
        );
      }
      // Until the notice is out, neither a probe nor a sleep runs past the
      // half mark, so it lands on time instead of after a 2 s probe.
      const untilHalf = noticed ? Number.POSITIVE_INFINITY : Math.max(READY_POLL_MIN_MS, remaining - half);
      if (
        readyUrl !== undefined &&
        (await answers(readyUrl, Math.min(READY_PROBE_TIMEOUT_MS, remaining, untilHalf), signal))
      ) {
        return;
      }
      // The exit event wakes the wait early so an exit is seen at once, not on the next poll.
      await Promise.race([
        sleep(Math.min(pollMs, untilHalf, Math.max(0, deadline - Date.now())), signal).catch(() => undefined),
        exited,
      ]);
      pollMs = Math.min(pollMs * 2, READY_POLL_MAX_MS);
    }
  }

  /**
   * The startup failure with the log's tail under it, so the report alone
   * says what the process was doing when it stalled or died. The message
   * lands in the report, so `command.env` values are redacted from the quote
   * with the same redactor and markers as the traces, the way the log itself
   * never is. Without a log there is nothing to quote, and the message says
   * how to get one.
   */
  private unreachable(message: string, logOffset: number | undefined): InfrastructureError {
    if (logOffset === undefined) {
      return new InfrastructureError('APP_UNREACHABLE', `${message}\nset log on this command to keep its output`);
    }
    const redact = createRedactor(
      Object.entries(this.command.env ?? {}).filter(([, value]) => value.length >= REDACTED_ENV_MIN_LENGTH),
    );
    const lines = this.outputSince(logOffset).map(redact);
    const detail =
      lines.length === 0
        ? `no output in ${this.logDisplayPath()}`
        : `output in ${this.logDisplayPath()} since ${this.label} started:\n${lines.map((line) => `  ${line}`).join('\n')}`;
    return new InfrastructureError('APP_UNREACHABLE', `${message}\n${detail}`);
  }

  /**
   * The last lines appended to the log past `offset`, terminal controls
   * stripped, bounded in bytes before lines so a chatty process cannot turn
   * the message into the whole log.
   */
  private outputSince(offset: number): string[] {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.logPath(), 'r');
      const end = fs.fstatSync(fd).size;
      const start = Math.max(offset, end - OUTPUT_TAIL_BYTES);
      if (end <= start) return [];
      // One byte before a cut tells whether it landed mid-line: a fragment
      // says nothing and goes, a line that ended right at the cut stays.
      const readFrom = start > offset ? start - 1 : start;
      const buffer = Buffer.alloc(end - readFrom);
      fs.readSync(fd, buffer, 0, buffer.length, readFrom);
      const text = buffer.toString('utf8');
      const cutMidLine = start > offset && !/^[\r\n]/.test(text);
      const lines = stripVTControlCharacters(text)
        .split(/\r\n|\n|\r/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      if (cutMidLine) lines.shift();
      return lines.slice(-OUTPUT_TAIL_LINES);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private logPath(): string {
    return path.resolve(this.projectRoot, this.command.log ?? '');
  }

  /** The log as the config names it, relative to the project root, for messages. */
  private logDisplayPath(): string {
    return path.relative(this.projectRoot, this.logPath());
  }

  /**
   * Opens `command.log` for appending, creating its directory, and returns
   * the descriptor the child writes stdout and stderr to. No `log` means the
   * output is discarded as before. The same file across services and runs
   * accumulates, which is what a developer reading a failed boot wants.
   */
  private openLog(): number | undefined {
    if (this.command.log === undefined) return undefined;
    const logPath = this.logPath();
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      return fs.openSync(logPath, 'a');
    } catch (cause) {
      throw new InfrastructureError(
        'APP_UNREACHABLE',
        `${this.label} could not open its log file ${logPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  /** Gracefully terminates the whole process group, then force-kills. A reused process was never ours to stop. */
  async stop(): Promise<void> {
    if (this.reusedExisting) return;
    const child = this.child;
    this.child = null;
    if (child === null) return;
    const shutdownTimeout = this.command.shutdownTimeout ?? 10_000;
    signalProcessGroup(child, 'SIGTERM');
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // The timer is cancelled once the process is gone: left pending, it kept
    // the event loop alive for the whole timeout after the run had ended.
    const timer = new AbortController();
    const timedOut = sleep(shutdownTimeout, timer.signal).then(
      () => 'timeout' as const,
      () => 'exited' as const,
    );
    const groupExited = (async () => {
      while (processGroupRunning(child)) {
        const poll = sleep(25, timer.signal);
        // Leader exit wakes each wait; surviving descendants keep the polling cadence.
        await (child.exitCode === null && child.signalCode === null ? Promise.race([exited, poll]) : poll);
      }
    })().catch(() => undefined);
    const winner = await Promise.race([groupExited.then(() => 'exited' as const), timedOut]);
    timer.abort();
    if (winner === 'timeout') {
      signalProcessGroup(child, 'SIGKILL');
      await exited.catch(() => undefined);
    }
    live.delete(child);
  }
}

/** What one started process, or everything a run or a session started, is released by. */
export interface AppProcesses {
  /**
   * Stops what was started, in reverse. Every failure is reported through
   * `onFailure` and never skips the rest, so one failing stop cannot leave
   * the others running.
   */
  stop(onFailure: (cause: unknown) => void): Promise<void>;
}
