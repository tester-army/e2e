/**
 * `e2e explore`: a run whose one test is a goal. The project config is loaded
 * as `run` loads it, the explorer replaces the agent executor, and the
 * exploration body is registered in memory as the run's only test, so the
 * reporters, `report.json`, artifacts, video, the AI trace, and the exit
 * codes are the runner's own. The record of the exploration rides along as
 * `run.explore`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultAgent, type DefaultAgent } from '../agent/default-agent.ts';
import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ReportExplore } from '../report/build.ts';
import { run, type RunOptions, type RunOutcome } from '../run/runner.ts';
import type { AgentConfig, BuiltinReporter, E2EConfig, Target } from '../types.ts';
import { createExploreBody } from './body.ts';
import { createExplorer } from './executor.ts';
import { exploreReporter } from './reporter.ts';
import { ExploreState } from './state.ts';

const DEFAULT_GOAL = 'Explore the app and find bugs';
/** Exploration steps per run: breadth first, and diminishing returns come fast. */
export const STEP_BOUNDS = { min: 1, max: 12, default: 8 } as const;
/** The run's wall clock in milliseconds: three to fifteen minutes. */
export const TIMEOUT_BOUNDS = { min: 180_000, max: 900_000, default: 600_000 } as const;
const MAX_GOAL_CHARS = 2_000;
/** Each step's action and model-call budget when the config sets none: a charter is longer than a scripted step. */
const DEFAULT_STEP_BUDGET = 40;
/** One charter's own deadline; the run's remaining time caps it. */
const STEP_TIMEOUT_MS = 240_000;
/** Added to the test timeout so the body's own clock ends the exploration before the attempt's does. */
const TIMEOUT_GRACE_MS = 60_000;
/** The virtual file the report and the reporters show for the exploration. */
const EXPLORE_FILE = 'explore';

export interface ExploreOptions {
  readonly goal?: string | undefined;
  readonly cwd?: string | undefined;
  readonly configPath?: string | undefined;
  /** The target to explore; with several configured and none named, the first is explored. */
  readonly target?: string | undefined;
  readonly maxSteps?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headed?: boolean | undefined;
  readonly reporters?: readonly BuiltinReporter[] | undefined;
  readonly artifactsDir?: string | undefined;
  readonly debug?: boolean | undefined;
  readonly aiTrace?: boolean | undefined;
  readonly video?: boolean | undefined;
  readonly interruptSignal?: AbortSignal | undefined;
  readonly forceSignal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * A config value instead of a discovered file, for the test harness: it may
   * hold a scripted model, which no config file could. `cwd` is the project
   * root then.
   */
  readonly rawConfig?: E2EConfig | undefined;
  /** Notices decided before the run starts: the target chosen, a replaced executor. */
  readonly notice?: ((message: string) => void) | undefined;
}

export interface ExploreOutcome extends RunOutcome {
  readonly explore: ReportExplore;
}

/** Runs one exploration and returns the run's outcome with the exploration record. */
export async function explore(options: ExploreOptions = {}): Promise<ExploreOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const notice = options.notice ?? (() => undefined);
  const goal = resolveGoal(options.goal);
  const budgets = {
    maxSteps: resolveBounded(options.maxSteps, STEP_BOUNDS, 'maxSteps'),
    timeoutMs: resolveBounded(options.timeoutMs, TIMEOUT_BOUNDS, 'timeout'),
  };

  const { raw, projectRoot } = await loadRawConfig(options, cwd);

  const state = new ExploreState(goal, budgets);
  const evidence = evidenceWriter(resolveArtifactsRoot(projectRoot, options.artifactsDir));
  const rawConfig: E2EConfig = {
    ...raw,
    agent: exploreAgentConfig(raw.agent, { state, evidence, notice }),
    // Nothing replays an exploration, and a retry would explore twice.
    cache: 'off',
    retries: 0,
    reporters: [...(raw.reporters ?? ['list']), exploreReporter(state)],
  };
  const runOptions: RunOptions = {
    cwd: projectRoot,
    rawConfig,
    env,
    tests: { file: EXPLORE_FILE, registration: exploreRegistration(state) },
    targetIds: pickTarget(raw.targets, options.target, notice),
    headed: options.headed,
    reporters: options.reporters,
    artifactsDir: options.artifactsDir,
    debug: options.debug,
    aiTrace: options.aiTrace,
    video: options.video,
    interruptSignal: options.interruptSignal,
    forceSignal: options.forceSignal,
    exploreReport: () => state.snapshot(),
  };
  const outcome = await run(runOptions);
  return { ...outcome, explore: state.snapshot() };
}

async function loadRawConfig(options: ExploreOptions, cwd: string): Promise<{ raw: E2EConfig; projectRoot: string }> {
  if (options.rawConfig !== undefined) return { raw: options.rawConfig, projectRoot: cwd };
  const discovered = discoverConfig(cwd, options.configPath);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  return { raw: await loadConfigModule(discovered.configPath), projectRoot: discovered.projectRoot };
}

function resolveGoal(goal: string | undefined): string {
  const trimmed = goal?.trim() ?? '';
  if (trimmed === '') return DEFAULT_GOAL;
  if (trimmed.length > MAX_GOAL_CHARS) {
    throw new ConfigurationError('INVALID_CONFIG', `the goal must be at most ${MAX_GOAL_CHARS} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

function resolveBounded(
  value: number | undefined,
  bounds: { readonly min: number; readonly max: number; readonly default: number },
  label: string,
): number {
  if (value === undefined) return bounds.default;
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an integer from ${bounds.min} through ${bounds.max}, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The agent block the exploration runs with. A project agent built by
 * `createAgent` lends its tools, guidance, model, and provider options; a
 * hand-rolled executor has no readable vocabulary and is replaced, with a
 * notice. Every other agent option keeps the project's value; the per-step
 * budgets default higher than a scripted step's.
 */
function exploreAgentConfig(
  value: E2EConfig['agent'],
  options: { state: ExploreState; evidence: (index: number, pixels: Uint8Array) => Promise<string | undefined>; notice: (message: string) => void },
): AgentConfig | StepExecutor {
  const bare = isStepExecutor(value) ? value : undefined;
  const block = bare === undefined ? (value as AgentConfig | undefined) : undefined;
  // A block that is not an object is left for config resolution to reject.
  if (block !== undefined && (typeof block !== 'object' || block === null || Array.isArray(block))) return block;
  const executor = bare ?? block?.executor;
  let base: DefaultAgent | undefined;
  if (executor !== undefined) {
    if (isDefaultAgent(executor)) {
      base = executor;
    } else {
      options.notice(
        `the configured agent "${executor.name}" is a custom executor; explore runs the built-in agent instead` +
          (executor.model === undefined ? '' : ', with the model from agent.model or E2E_MODEL'),
      );
    }
  }
  const explorer = createExplorer({ state: options.state, base, evidence: options.evidence });
  return {
    ...block,
    executor: explorer,
    maxSteps: block?.maxSteps ?? DEFAULT_STEP_BUDGET,
    maxModelCalls: block?.maxModelCalls ?? DEFAULT_STEP_BUDGET,
  };
}

/** The target to explore, or undefined for the runner's default when one target is configured. */
function pickTarget(
  targets: readonly Target[] | undefined,
  requested: string | undefined,
  notice: (message: string) => void,
): readonly string[] | undefined {
  if (requested !== undefined) return [requested];
  if (!Array.isArray(targets) || targets.length <= 1) return undefined;
  const first = targets[0] as { name?: unknown } | undefined;
  if (typeof first?.name !== 'string') return undefined;
  notice(`exploring target "${first.name}"; pass --target to explore another`);
  return [first.name];
}

/** The one-test registration: the goal is the title, the body is the exploration loop. */
function exploreRegistration(state: ExploreState): ModuleRegistration {
  const title = state.goal;
  const test: RegisteredTest = {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex: 0,
    options: {
      timeout: state.budgets.timeoutMs + TIMEOUT_GRACE_MS,
      retries: 0,
      agentContext: `Exploration goal: ${state.goal}`,
    },
    sessions: [],
    fn: createExploreBody({ state, stepTimeoutMs: STEP_TIMEOUT_MS }),
    group: undefined,
    mode: 'normal',
    source: undefined,
  };
  return { tests: [test], hooks: [] };
}

function resolveArtifactsRoot(projectRoot: string, override: string | undefined): string {
  if (override !== undefined) return path.resolve(projectRoot, override);
  return path.join(projectRoot, '.e2e', 'artifacts');
}

/**
 * Writes finding evidence under `<artifacts>/explore/<launch time>/` and
 * returns the artifact-root-relative path the report records.
 */
function evidenceWriter(artifactsRoot: string): (index: number, pixels: Uint8Array) => Promise<string | undefined> {
  const folder = path.posix.join('explore', new Date().toISOString().replace(/[:.]/g, '-'));
  return async (index, pixels) => {
    const file = `finding-${index + 1}.png`;
    const dir = path.join(artifactsRoot, ...folder.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), pixels);
    return path.posix.join(folder, file);
  };
}
