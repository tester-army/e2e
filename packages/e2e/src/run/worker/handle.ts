/** Child-process `UnitRunner`: spawn, messaging, exit tracking. */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { InfrastructureError } from '../../internal/errors.ts';
import type { SpawnUnitRunner, UnitRunner, UnitRunnerEvents } from '../unit-runner.ts';
import type {
  ChildProcessInbound,
  MainToWorker,
  WorkerBootstrap,
  WorkerToMain,
} from './protocol.ts';

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

/** Run-wide settings every child-process worker boots with. */
export type ChildProcessSpawnOptions = Omit<WorkerBootstrap, 'targetName'> & {
  readonly env: NodeJS.ProcessEnv;
};

/** Creates the spawn factory the scheduler uses for child-process execution. */
export function childProcessSpawner(options: ChildProcessSpawnOptions): SpawnUnitRunner {
  const { env, ...bootstrap } = options;
  return (targetName, events) =>
    new ChildProcessRunner(
      { ...bootstrap, targetName },
      { projectRoot: bootstrap.projectRoot, env },
      events,
    );
}

/** One live worker process bound to a single target. */
class ChildProcessRunner implements UnitRunner {
  readonly exit: Promise<void>;
  private readonly child: ChildProcess;
  private exited = false;

  constructor(
    bootstrap: WorkerBootstrap,
    spawn: { projectRoot: string; env: NodeJS.ProcessEnv },
    events: UnitRunnerEvents,
  ) {
    const entry = resolveEntry();
    this.child = fork(entry.path, [], {
      cwd: spawn.projectRoot,
      execArgv: entry.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: spawn.env,
    });
    this.child.on('message', (message) => events.onMessage(message as WorkerToMain));
    this.exit = new Promise<void>((resolve) => {
      // 'close', not 'exit': it fires once the IPC channel has drained, so
      // every message the worker sent (its shutdown-done included) has been
      // delivered before the scheduler treats the worker as gone.
      this.child.once('close', (code, signal) => {
        this.exited = true;
        events.onExit(`code ${String(code)}, signal ${String(signal)}`);
        resolve();
      });
    });
    this.child.once('error', () => {
      // spawn failures surface through the close event
    });
    this.post({ type: 'bootstrap', bootstrap });
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(message: MainToWorker): void {
    this.post(message);
  }

  private post(message: ChildProcessInbound): void {
    if (this.exited) return;
    try {
      this.child.send(message);
    } catch {
      // channel already closed; the exit event handles cleanup
    }
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }
}
