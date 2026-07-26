/** Runner-side worker process lifecycle: spawn, messaging, exit tracking. */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { InfrastructureError } from '../../internal/errors.ts';
import type { InitMessage, MainToWorker, WorkerToMain } from './protocol.ts';

export interface WorkerEvents {
  onMessage(message: WorkerToMain): void;
  /** Fires once when the process exits for any reason. */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

/** Resolves the worker entry for both src (vitest, .ts) and dist (.js) layouts. */
function resolveEntry(): { path: string; execArgv: string[] } {
  const js = fileURLToPath(new URL('./entry.js', import.meta.url));
  if (existsSync(js)) return { path: js, execArgv: [] };
  const ts = fileURLToPath(new URL('./entry.ts', import.meta.url));
  if (existsSync(ts)) {
    const require = createRequire(import.meta.url);
    return { path: ts, execArgv: ['--import', require.resolve('tsx')] };
  }
  throw new InfrastructureError('WORKER_ENTRY_MISSING', 'e2e worker entry module not found');
}

/** One live worker process bound to a single target. */
export class WorkerHandle {
  readonly targetName: string;
  /** Resolves when the process exits for any reason. */
  readonly exit: Promise<void>;
  private readonly child: ChildProcess;
  private exited = false;

  constructor(
    init: Omit<InitMessage, 'type'>,
    spawn: { projectRoot: string; env: NodeJS.ProcessEnv },
    events: WorkerEvents,
  ) {
    this.targetName = init.targetName;
    const entry = resolveEntry();
    this.child = fork(entry.path, [], {
      cwd: spawn.projectRoot,
      execArgv: entry.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: spawn.env,
    });
    this.child.on('message', (message) => events.onMessage(message as WorkerToMain));
    this.exit = new Promise<void>((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        events.onExit(code, signal);
        resolve();
      });
    });
    this.child.once('error', () => {
      // spawn failures surface through the exit event
    });
    this.send({ type: 'init', ...init });
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(message: MainToWorker): void {
    if (this.exited) return;
    try {
      this.child.send(message);
    } catch {
      // channel already closed; the exit event handles cleanup
    }
  }

  /** Graceful shutdown request; the worker disposes its driver and exits. */
  shutdown(): void {
    this.send({ type: 'shutdown' });
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }
}
