/** Structured app process management (spec 05-config.md). */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { InfrastructureError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import type { CommandConfig, ServiceConfig } from '../types.ts';

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC'] as const;

/** Readiness polling starts fast and backs off; a booting server answers late, not on a schedule. */
const READY_POLL_MIN_MS = 25;
const READY_POLL_MAX_MS = 250;
/** One readiness probe never outlives this, so a half-open server cannot stall the deadline check. */
const READY_PROBE_TIMEOUT_MS = 2_000;

/**
 * How a process counts as ready: a URL that answers, or the process itself
 * exiting with code 0 (a migration, `docker compose up --wait`).
 */
type Readiness = { readonly readyUrl: string } | { readonly waitForExit: true };

interface ExitStatus {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function describeExit(exit: ExitStatus): string {
  return exit.code === null ? `was terminated by ${exit.signal}` : `exited with code ${exit.code}`;
}

export class AppProcess {
  private child: ChildProcess | null = null;

  constructor(
    private readonly command: CommandConfig,
    private readonly projectRoot: string,
    private readonly readiness: Readiness,
    private readonly label = 'app command',
  ) {}

  /**
   * Spawns the process group and waits for readiness. An aborted `signal`
   * ends the wait early and takes the process down with it; the caller reads
   * the signal to learn the run was interrupted.
   */
  async start(signal?: AbortSignal): Promise<void> {
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.command.env ?? {});

    const child = spawn(this.command.executable, [...(this.command.args ?? [])], {
      cwd: path.resolve(this.projectRoot, this.command.cwd ?? '.'),
      env,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
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

    const waitForExit = 'waitForExit' in this.readiness;
    const startupTimeout = this.command.startupTimeout ?? 60_000;
    const deadline = Date.now() + startupTimeout;
    let pollMs = READY_POLL_MIN_MS;
    for (;;) {
      if (signal?.aborted === true) {
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
        if (waitForExit && exit.code === 0) return;
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `${this.label} ${describeExit(exit)} ${waitForExit ? 'instead of 0' : 'before becoming ready'}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.stop();
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          'readyUrl' in this.readiness
            ? `${this.label} was not reachable at ${this.readiness.readyUrl} within ${startupTimeout} ms`
            : `${this.label} did not exit within ${startupTimeout} ms`,
        );
      }
      if ('readyUrl' in this.readiness) {
        try {
          const response = await fetch(this.readiness.readyUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(READY_PROBE_TIMEOUT_MS, remaining)),
          });
          if (response.status >= 200 && response.status <= 499) return;
        } catch {
          // not ready yet
        }
      }
      // The exit event wakes the wait early so an exit is seen at once, not on the next poll.
      await Promise.race([
        sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal).catch(() => undefined),
        exited,
      ]);
      pollMs = Math.min(pollMs * 2, READY_POLL_MAX_MS);
    }
  }

  /** Gracefully terminates the whole process group, then force-kills. */
  async stop(): Promise<void> {
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

function commandLine(command: CommandConfig): string {
  return [command.executable, ...(command.args ?? [])].join(' ');
}

/** Names a service in error messages by its position and command line, since services carry no name. */
function serviceLabel(index: number, service: ServiceConfig): string {
  return `app.services[${index}] (${commandLine(service)})`;
}

/**
 * The dependency processes of `app.services` (spec 05-config.md): started
 * sequentially in declaration order, each ready before the next starts, and
 * torn down in reverse.
 */
export class ServiceStack {
  private readonly started: {
    readonly process: AppProcess;
    readonly service: ServiceConfig;
    readonly label: string;
  }[] = [];

  constructor(
    private readonly services: readonly ServiceConfig[],
    private readonly projectRoot: string,
  ) {}

  /**
   * Starts every service in order. Stops early once `signal` aborts; the
   * services already started still get their teardown from `stop`.
   */
  async start(signal?: AbortSignal): Promise<void> {
    for (const [index, service] of this.services.entries()) {
      if (signal?.aborted === true) return;
      const readiness: Readiness =
        service.waitForExit === true ? { waitForExit: true } : { readyUrl: service.readyUrl ?? '' };
      const label = serviceLabel(index, service);
      const process = new AppProcess(service, this.projectRoot, readiness, label);
      this.started.push({ process, service, label });
      await process.start(signal);
    }
  }

  /**
   * Stops the started services in reverse order, then runs each of their
   * `teardown` commands in reverse order and waits for it to exit. Teardown
   * failures are returned, never thrown, so one failing `docker compose down`
   * cannot skip the rest.
   */
  async stop(): Promise<readonly unknown[]> {
    const started = this.started.splice(0).toReversed();
    for (const { process } of started) await process.stop();
    const failures: unknown[] = [];
    for (const { service, label } of started) {
      const teardown = service.teardown;
      if (teardown === undefined) continue;
      const teardownLabel = `${label} teardown (${commandLine(teardown)})`;
      try {
        await new AppProcess(teardown, this.projectRoot, { waitForExit: true }, teardownLabel).start();
      } catch (cause) {
        failures.push(cause);
      }
    }
    return failures;
  }
}
