/**
 * What a run and a standalone attempt both do before the first engine
 * session: grade each target against its engine declaration, run the
 * engines' `prepare` hooks, and start the app processes the engines declare.
 * One owner, so the dev-loop session (`e2e mcp`) and a test run can never
 * provision differently.
 */

import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, translateProvisioningError } from '../internal/errors.ts';
import { describeTarget, type TargetProvenance } from '../report/build.ts';
import { declaredProcesses } from './declared-processes.ts';
import { ManagedProcess, ServiceStack, type ManagedProcessHooks } from './managed-process.ts';

/**
 * Grades one target from its engine declaration and validates the configured
 * artifacts against it; returns the report provenance.
 */
export function validateEngine(target: ResolvedTarget, config: ResolvedConfig): TargetProvenance {
  const provenance = describeTarget(target);
  // The default artifact set is best-effort: an engine without evidence
  // capture simply records none. Asking for one explicitly is a contract.
  for (const artifact of config.artifactsExplicit ? config.artifacts : []) {
    if (!provenance.artifactCapabilities.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `target "${target.name}" (engine ${provenance.engine.name}) does not support the configured "${artifact}" artifact`,
      );
    }
  }
  return provenance;
}

/**
 * Runs each target's `prepare` hook in turn. Sequential on purpose: two
 * engines provisioning the same toolchain would race, and the notices of
 * one download read better than two interleaved.
 */
export async function prepareEngines(
  targets: readonly ResolvedTarget[],
  scope: { runId: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
  notice: (target: string, message: string) => void,
): Promise<void> {
  for (const target of targets) {
    const engine = target.engine;
    if (engine?.prepare === undefined) continue;
    if (scope.signal.aborted) return;
    try {
      // The same `env` the workers are started with: what prepare provisions
      // must be where a worker's launch will look for it.
      await engine.prepare({
        runId: scope.runId,
        targetName: target.name,
        env: scope.env,
        signal: scope.signal,
        log: (line) => notice(target.name, line),
      });
    } catch (cause) {
      throw translateProvisioningError(cause, ` while preparing engine ${engine.name} for target "${target.name}"`);
    }
  }
}

/** The app processes one run or session started, torn down in reverse. */
export interface AppProcesses {
  /**
   * Stops the app commands, then the services and their teardown commands.
   * Every failure is reported through `onFailure` and never skips the rest,
   * so one failing stop cannot leave the others running.
   */
  stop(onFailure: (cause: unknown) => void): Promise<void>;
}

/**
 * Starts what the targets' engines declare: the dependency services first,
 * then every distinct app command. Declarations are deduplicated across
 * targets (two browsers on one dev server share one process), and every
 * service is ready before the first app command starts. Nothing spawns once
 * `signal` aborted; what did start is returned for teardown either way.
 */
export async function startDeclaredProcesses(
  targets: readonly ResolvedTarget[],
  projectRoot: string,
  hooks: ManagedProcessHooks,
  signal: AbortSignal,
  debug: DebugTrace,
): Promise<AppProcesses> {
  const declared = declaredProcesses(targets);
  let services: ServiceStack | undefined;
  const apps: ManagedProcess[] = [];
  const processes: AppProcesses = {
    async stop(onFailure) {
      for (const app of apps.splice(0).toReversed()) {
        try {
          await app.stop();
        } catch (cause) {
          onFailure(cause);
        }
      }
      await services?.stop(onFailure);
    },
  };
  if (declared.services.length > 0) {
    const stack = new ServiceStack(declared.services, projectRoot, hooks);
    services = stack;
    await debug.time('app.services.start', () => stack.start(signal));
    if (signal.aborted) return processes;
  }
  for (const { label, command, readyUrl } of declared.commands) {
    const app = new ManagedProcess(label, command, projectRoot, { readyUrl }, hooks);
    apps.push(app);
    await debug.time(`app.start(${label})`, () => app.start(signal));
    if (signal.aborted) return processes;
  }
  return processes;
}
