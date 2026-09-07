/** Spawned-process management for the commands and services engines declare, and their teardowns. */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readiness, ResolvedService } from '../config/app.ts';
import { InfrastructureError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import type { CommandConfig } from '../types.ts';

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC'] as const;

/** Readiness polling starts fast and backs off; a booting server answers late, not on a schedule. */
const READY_POLL_MIN_MS = 25;
const READY_POLL_MAX_MS = 250;
/** One readiness probe never outlives this, so a half-open server cannot stall the deadline check. */
const READY_PROBE_TIMEOUT_MS = 2_000;

interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function describeExit(exit: ExitStatus): string {
  return exit.code === null ? `was terminated by ${exit.signal}` : `exited with code ${exit.code}`;
}

/** One readiness probe: true when `url` answers 200 through 499 within `timeoutMs`. */
async function answers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return response.status >= 200 && response.status <= 499;
  } catch {
    return false;
  }
}

/**
 * What the runner tells a managed process about the run: whether CI mode is
 * active (where `reuseExisting` is ignored) and where to narrate run-level
 * progress such as a reused app.
 */
export interface ManagedProcessHooks {
  readonly ci?: boolean;
  readonly notice?: (message: string) => void;
}

/**
 * One command the runner owns: spawned as a process group, waited on until
 * its readiness contract holds, and terminated signal-then-force. `label`
 * names it in every error (`target "web" command`, `service "postgres"`).
 */
export class ManagedProcess {
  private child: ChildProcess | null = null;
  private reusedExisting = false;

  constructor(
    private readonly label: string,
    private readonly command: CommandConfig,
    private readonly projectRoot: string,
    private readonly readiness: Readiness,
    private readonly hooks: ManagedProcessHooks = {},
  ) {}

  /** True once `start` found the readiness URL already answering and attached to it instead of spawning. */
  get reused(): boolean {
    return this.reusedExisting;
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
      if (await answers(readyUrl, Math.min(READY_PROBE_TIMEOUT_MS, startupTimeout))) {
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
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `${this.label} ${describeExit(exit)} ${readyUrl === undefined ? 'instead of 0' : 'before becoming ready'}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.stop();
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          readyUrl === undefined
            ? `${this.label} did not exit within ${startupTimeout} ms`
            : `${this.label} was not reachable at ${readyUrl} within ${startupTimeout} ms`,
        );
      }
      if (readyUrl !== undefined && (await answers(readyUrl, Math.min(READY_PROBE_TIMEOUT_MS, remaining)))) {
        return;
      }
      // The exit event wakes the wait early so an exit is seen at once, not on the next poll.
      await Promise.race([
        sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal).catch(() => undefined),
        exited,
      ]);
      pollMs = Math.min(pollMs * 2, READY_POLL_MAX_MS);
    }
  }

  /**
   * Opens `command.log` for appending, creating its directory, and returns
   * the descriptor the child writes stdout and stderr to. No `log` means the
   * output is discarded as before. The same file across services and runs
   * accumulates, which is what a developer reading a failed boot wants.
   */
  private openLog(): number | undefined {
    if (this.command.log === undefined) return undefined;
    const logPath = path.resolve(this.projectRoot, this.command.log);
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
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const shutdownTimeout = this.command.shutdownTimeout ?? 10_000;
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        if (process.platform !== 'win32') process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        // process already gone
      }
    };
    signalGroup('SIGTERM');
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    const timer = sleep(shutdownTimeout).then(() => 'timeout' as const);
    const winner = await Promise.race([exited.then(() => 'exited' as const), timer]);
    if (winner === 'timeout') {
      signalGroup('SIGKILL');
      await exited.catch(() => undefined);
    }
  }
}

/**
 * The dependency processes the engines declared as `services`: started
 * sequentially in declaration order, each ready before the next starts, and
 * torn down in reverse.
 */
export class ServiceStack {
  private readonly started: {
    readonly service: ManagedProcess;
    readonly teardown: ManagedProcess | undefined;
  }[] = [];

  constructor(
    private readonly services: readonly ResolvedService[],
    private readonly projectRoot: string,
    private readonly hooks: ManagedProcessHooks = {},
  ) {}

  /**
   * Starts every service in order. Stops early once `signal` aborts; the
   * services already started still get their teardown from `stop`.
   */
  async start(signal?: AbortSignal): Promise<void> {
    for (const { label, command, readiness, teardown } of this.services) {
      if (signal?.aborted === true) return;
      const service = new ManagedProcess(label, command, this.projectRoot, readiness, this.hooks);
      this.started.push({
        service,
        teardown:
          teardown === undefined
            ? undefined
            : new ManagedProcess(teardown.label, teardown.command, this.projectRoot, {
                waitForExit: true,
              }),
      });
      await service.start(signal);
    }
  }

  /**
   * Stops the started services in reverse order, then runs each of their
   * teardown commands in reverse order and waits for it to exit. A failing
   * teardown is reported through `onFailure` and never skips the rest, so one
   * failing `docker compose down` cannot leave the others running. A reused
   * service was not started by this run, so its teardown does not run either.
   */
  async stop(onFailure: (cause: unknown) => void): Promise<void> {
    const started = this.started.splice(0).toReversed();
    for (const { service } of started) await service.stop();
    for (const { service, teardown } of started) {
      if (teardown === undefined || service.reused) continue;
      try {
        await teardown.start();
      } catch (cause) {
        onFailure(cause);
      }
    }
  }
}
