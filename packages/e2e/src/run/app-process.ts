/** Structured app process management (spec 05-config.md). */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { InfrastructureError } from '../internal/errors.js';
import { sleep } from '../internal/time.js';
import type { CommandConfig } from '../types.js';

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC'] as const;

export class AppProcess {
  private child: ChildProcess | null = null;

  constructor(
    private readonly command: CommandConfig,
    private readonly projectRoot: string,
    private readonly readyUrl: string,
  ) {}

  /** Spawns the process group and waits for the ready URL. */
  async start(): Promise<void> {
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
    this.child.on('error', () => undefined);

    const startupTimeout = this.command.startupTimeout ?? 60_000;
    const deadline = Date.now() + startupTimeout;
    for (;;) {
      if (this.child.exitCode !== null) {
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `app command exited with code ${this.child.exitCode} before becoming ready`,
        );
      }
      try {
        const response = await fetch(this.readyUrl, { redirect: 'manual' });
        if (response.status >= 200 && response.status <= 499) return;
      } catch {
        // not ready yet
      }
      if (Date.now() >= deadline) {
        await this.stop();
        throw new InfrastructureError(
          'APP_UNREACHABLE',
          `app was not reachable at ${this.readyUrl} within ${startupTimeout} ms`,
        );
      }
      await sleep(250);
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
