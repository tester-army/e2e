/**
 * `explore` on `e2e/runner`: one exploration in the caller's process, the
 * public counterpart of `e2e explore` as `run` is of `e2e run`. It owns the
 * process as a public run does, renders nothing, and returns the report and
 * the exploration record without live engine or configuration handles.
 */

import type { ReportExplore } from '../report/build.ts';
import type { RunEventSink } from '../run/events.ts';
import { ownedRun, runResult, type RunResult } from '../run/public-run.ts';
import { toSelectionRunOptions } from '../run/runner.ts';
import type { E2EConfig } from '../types.ts';
import { explore } from './index.ts';

/** Options for one exploration through the public runner API. Recording and output settings come from the config. */
export interface ExplorationOptions {
  /** The project directory; default: the current working directory. */
  readonly cwd?: string | undefined;
  /** A config file path, or a config value in place of a file. Omit it to discover `e2e.config.ts` from `cwd`. */
  readonly config?: string | E2EConfig | undefined;
  /** What to explore, at most 2,000 characters; default: `Explore the app and find bugs`. */
  readonly goal?: string | undefined;
  /** The target to explore; default: the first configured. */
  readonly target?: string | undefined;
  /** The configured agent (`agents.<name>`) the exploration runs as; default: `agents.default`. */
  readonly agent?: string | undefined;
  /** A session a setup test saves: that setup runs first, and the exploration starts from the state it saved. */
  readonly session?: string | undefined;
  /** Exploration steps, from 1 through 12; default: 8. */
  readonly maxSteps?: number | undefined;
  /** The exploration's time limit in milliseconds, from 180000 through 900000; default: 600000. */
  readonly timeoutMs?: number | undefined;
  /** Abort to interrupt the exploration; its teardown runs before the call resolves. */
  readonly interruptSignal?: AbortSignal | undefined;
  /**
   * Typed progress: the run's events, an `explore` event for each planning
   * decision, step, and finding, and the notices decided before the run as
   * `run` notices. Must not block; a throwing or rejecting sink is disabled
   * without failing the run.
   */
  readonly onEvent?: RunEventSink | undefined;
}

/** The completed exploration: the run's result and the record of what it explored and found. */
export interface ExplorationResult extends RunResult {
  readonly explore: ReportExplore;
}

/**
 * Explores the app toward a goal without exiting the caller; await its
 * cleanup before starting another run. A goal or budget out of range, a
 * config that does not load or resolve, an unknown target or agent, or an
 * agent with no model rejects before anything starts, as the CLI's flags
 * do; once the run starts, failures and interruption resolve with their
 * status in the report.
 */
export async function runExploration(options: ExplorationOptions = {}): Promise<ExplorationResult> {
  const { configPath, rawConfig } = toSelectionRunOptions({ config: options.config });
  // Named one by one, as `run` passes its options: a caller's extra keys, such as the CLI's reporters or output, never reach the explorer.
  const outcome = await ownedRun('runner.explore', options, (owned) =>
    explore({
      cwd: options.cwd,
      configPath,
      rawConfig,
      goal: options.goal,
      target: options.target,
      agent: options.agent,
      session: options.session,
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      ...owned,
    }),
  );
  return { ...runResult(outcome), explore: outcome.explore };
}
