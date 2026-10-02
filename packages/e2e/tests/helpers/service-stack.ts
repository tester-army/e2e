/** The services a run starts for one target, through the run's own path, for tests that start and stop them by hand. */

import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { DebugTrace } from '../../src/internal/debug.ts';
import type { AppProcesses, ManagedProcessHooks } from '../../src/run/managed-process.ts';
import { startDeclaredProcesses } from '../../src/run/provision.ts';
import type { ServiceHandle } from '../../src/types.ts';

const ENGINE = defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, platform: 'fake' });

export interface ServiceStack {
  /** Starts every service the target needs, dependencies first; a failed start stops what started before it throws. */
  start(signal?: AbortSignal): Promise<void>;
  /** Stops what started, in reverse, and returns what failed. */
  stop(): Promise<unknown[]>;
}

/** The stack a run would start for one target listing `services`. */
export function serviceStack(
  services: readonly ServiceHandle[],
  options: { readonly projectRoot: string; readonly hooks?: ManagedProcessHooks; readonly cleanupTimeout?: number },
): ServiceStack {
  const config = resolveConfig({ targets: [{ name: 't', engine: ENGINE, services }] }, { projectRoot: options.projectRoot, env: {} });
  let processes: AppProcesses | undefined;
  return {
    async start(signal = new AbortController().signal) {
      if (processes !== undefined) throw new Error('the stack is already started: stop it first');
      processes = await startDeclaredProcesses(
        config.targets,
        { ...config, cleanupTimeout: options.cleanupTimeout ?? 5_000 },
        () => options.hooks ?? {},
        signal,
        new DebugTrace(false),
      );
    },
    async stop() {
      const failures: unknown[] = [];
      await processes?.stop((cause) => failures.push(cause));
      processes = undefined;
      return failures;
    },
  };
}
