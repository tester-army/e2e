/** Structured app process management (spec 05-config.md). */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { InfrastructureError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import type { CommandConfig } from '../types.ts';

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC'] as const;

/** Readiness polling starts fast and backs off; a booting server answers late, not on a schedule. */
const READY_POLL_MIN_MS = 25;
const READY_POLL_MAX_MS = 250;
/** One readiness probe never outlives this, so a half-open server cannot stall the deadline check. */
const READY_PROBE_TIMEOUT_MS = 2_000;

export class AppProcess {
  private child: ChildProcess | null = null;

  constructor(
    private readonly command: CommandConfig,
    private readonly projectRoot: string,
    private readonly readyUrl: string,
  ) {}

  /**
   * Spawns the process group and waits for the ready URL. An aborted `signal`
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

    this.child = spawn(this.command.executable, [...(this.command.args ?? [])], {
      cwd: path.resolve(this.projectRoot, this.command.cwd ?? '.'),
      env,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    let spawnError: Error | undefined;
    this.child.on('error', (error) => {
      spawnError = error;
    });

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
          `app command failed to start: ${spawnError.message}`,
          { cause: spawnError },
        );
      }
      if (this.child.exitCode !== null) {
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `app command exited with code ${this.child.exitCode} before becoming ready`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.stop();
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `app was not reachable at ${this.readyUrl} within ${startupTimeout} ms`,
        );
      }
      try {
        const response = await fetch(this.readyUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.min(READY_PROBE_TIMEOUT_MS, remaining)),
        });
        if (response.status >= 200 && response.status <= 499) return;
      } catch {
        // not ready yet
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal).catch(() => undefined);
      pollMs = Math.min(pollMs * 2, READY_POLL_MAX_MS);
    }
  }

  /** Gracefully terminates the whole process group, then force-kills. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
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
