/**
 * `e2e explore`: a run whose one test is a goal. The project config is loaded
 * as `run` loads it, the exploration body is registered in memory as the
 * run's only test, and within that test alone the explorer replaces the
 * executor of the agent the run uses, so the reporters, `report.json`,
 * artifacts, video, the AI trace, and the exit codes are the runner's own. The exploration's progress travels
 * as `explore` run events, which the list reporter renders, and its record
 * rides along as `run.explore`.
 */

import { MAX_PARAMS_BYTES } from '../agent/act-validation.ts';
import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import { selectTargets } from '../collect/select.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedCredential, type ResolvedTarget } from '../config/resolve.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ReportExplore } from '../report/build.ts';
import { labelSegment } from '../run/artifacts.ts';
import { run, type RunOutcome } from '../run/runner.ts';
import type { AgentConfig, BuiltinReporter, E2EConfig, VideoMode } from '../types.ts';
import { createExploreBody } from './body.ts';
import { createExplorer } from './executor.ts';
import { signedInContext, type PlanAccount } from './plan.ts';
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
/**
 * Every charter carries every configured account as a step parameter, and
 * step parameters have a size limit. The inventory takes at most a quarter of
 * it, leaving room for the findings that ride along, so an oversized one is a
 * configuration error before anything starts and not a failed first step.
 */
const MAX_CREDENTIAL_BYTES = MAX_PARAMS_BYTES / 4;

export interface ExploreOptions {
  readonly goal?: string | undefined;
  readonly cwd?: string | undefined;
  readonly configPath?: string | undefined;
  /** The target to explore; with several configured and none named, the first is explored. */
  readonly target?: string | undefined;
  /** The configured agent (`agents.<name>`) the exploration runs as; default: `agents.default`. */
  readonly agent?: string | undefined;
  /**
   * A session a setup test in the config's test files saves (`--session`):
   * that setup runs first, and the exploration starts from the state it
   * saved, as a test declaring `{ session }` does. No setup declaring it is
   * `COLLECTION_ERROR` before any process starts.
   */
  readonly session?: string | undefined;
  readonly maxSteps?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headed?: boolean | undefined;
  readonly reporters?: readonly BuiltinReporter[] | undefined;
  readonly artifactsDir?: string | undefined;
  readonly debug?: boolean | undefined;
  readonly aiTrace?: boolean | undefined;
  /** Which attempts record a video, `--video [mode]`; the exploration is one attempt, so `on-first-retry` records nothing. */
  readonly video?: VideoMode | undefined;
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

/**
 * Runs one exploration and returns the run's outcome with the exploration
 * record. The config is resolved once here, with the agent `--agent` named,
 * so the target, the agent the explorer is built from, and the credential
 * inventory are what the run resolves too; a config that does not resolve,
 * an unknown agent, or an unknown target is an error before anything starts,
 * as a bad flag is.
 */
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
  const resolveOptions = { projectRoot, env, cli: options.agent === undefined ? {} : { agents: [options.agent] } };
  const resolved = resolveConfig(raw, resolveOptions);
  const target = pickTarget(resolved.targets, options.target, notice);
  const accounts = credentialAccounts(resolved.credentials);
  // An exploration runs as exactly one agent: the one named, else `default`.
  const agentName = resolved.agentNames[0]!;
  if (agentName !== 'default') notice(`exploring with agent "${agentName}"`);

  const state = new ExploreState(goal, budgets);
  const explorer = createExplorer({ state, from: resolved.agent.executor, notice });
  // The explorer replaces the agent for the exploration alone: a setup test
  // `--session` pulls in runs as the project's own agents, with its cache and
  // retries. The exploration pins no retries and runs with the cache off.
  const explorerAgents = resolveConfig(
    { ...raw, agents: { ...raw.agents, [agentName]: exploreAgentConfig(raw.agents?.[agentName], explorer) } },
    resolveOptions,
  ).agents;
  const outcome = await run({
    cwd: projectRoot,
    rawConfig: raw,
    agent: options.agent,
    env,
    tests: {
      file: EXPLORE_FILE,
      registration: exploreRegistration(state, { openApp: target.app.base !== undefined, accounts, session: options.session }),
      agents: explorerAgents,
      explore: state,
    },
    targetIds: [target.name],
    headed: options.headed,
    reporters: options.reporters,
    artifactsDir: options.artifactsDir,
    debug: options.debug,
    aiTrace: options.aiTrace,
    video: options.video,
    interruptSignal: options.interruptSignal,
    forceSignal: options.forceSignal,
  });
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
 * The target to explore: the one `--target` names (an unknown one is
 * `UNKNOWN_TARGET`, as for `run`), else the first configured, with a notice
 * when there are several.
 */
function pickTarget(targets: readonly ResolvedTarget[], requested: string | undefined, notice: (message: string) => void): ResolvedTarget {
  const chosen = selectTargets(targets, requested === undefined ? undefined : [requested])[0];
  if (chosen === undefined) throw new Error('unreachable: a resolved config declares at least one target');
  if (requested === undefined && targets.length > 1) {
    notice(`exploring target "${chosen.name}"; pass --target to explore another`);
  }
  return chosen;
}

/**
 * The agent block the exploration runs as: the project's own options with the
 * explorer as the executor, and per-step budgets that default higher than a
 * scripted step's, a charter being longer. A bare executor has no options to
 * keep; the explorer already lent from it what it could.
 */
function exploreAgentConfig(entry: AgentConfig | StepExecutor | undefined, explorer: StepExecutor): AgentConfig {
  const block: AgentConfig = entry === undefined || isStepExecutor(entry) ? {} : entry;
  return {
    ...block,
    executor: explorer,
    maxSteps: block.maxSteps ?? DEFAULT_STEP_BUDGET,
    maxModelCalls: block.maxModelCalls ?? DEFAULT_STEP_BUDGET,
  };
}

/**
 * The accounts every charter carries, bounded to what a step parameter holds.
 * Measured as the step sees them: the usernames and the secret placeholders
 * the passwords become there.
 */
function credentialAccounts(credentials: ReadonlyMap<string, ResolvedCredential>): PlanAccount[] {
  const accounts = [...credentials.values()].map((credential) => ({ name: credential.name, username: credential.username }));
  const carried = Object.fromEntries(
    accounts.map((account) => [account.name, { username: account.username, password: { kind: 'secret', name: account.name, purpose: 'password' } }]),
  );
  const bytes = Buffer.byteLength(JSON.stringify({ credentials: carried }));
  if (bytes > MAX_CREDENTIAL_BYTES) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `explore carries every configured credential into each step: ${String(accounts.length)} account(s) serialize to ${String(bytes)} bytes, the maximum is ${String(MAX_CREDENTIAL_BYTES)}; explore with a config that declares fewer`,
    );
  }
  return accounts;
}

/**
 * The one-test registration: the goal is the title, the body is the
 * exploration loop. With a session it consumes that session like any test
 * declaring `{ session }`, so the runner runs the setup that saves it first
 * and restores it into the exploration's attempt. Its artifacts go under a
 * short name for the goal rather than the test id, which holds the whole
 * goal encoded.
 */
function exploreRegistration(
  state: ExploreState,
  start: { readonly openApp: boolean; readonly accounts: readonly PlanAccount[]; readonly session: string | undefined },
): ModuleRegistration {
  const title = state.goal;
  const { session } = start;
  const test: RegisteredTest = {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex: 0,
    options: {
      timeout: state.budgets.timeoutMs + TIMEOUT_GRACE_MS,
      retries: 0,
      agentContext: [`Exploration goal: ${state.goal}`, ...(session === undefined ? [] : [signedInContext(session)])].join('\n'),
      ...(session === undefined ? {} : { session }),
    },
    sessions: [],
    tags: [],
    fn: createExploreBody({ state, stepTimeoutMs: STEP_TIMEOUT_MS, ...start }),
    fixtures: [],
    group: undefined,
    mode: 'normal',
    source: undefined,
    artifactName: labelSegment(EXPLORE_FILE, state.goal),
  };
  return { tests: [test], hooks: [] };
}
