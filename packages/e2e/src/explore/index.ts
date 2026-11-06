/**
 * `e2e explore`: a run whose one test is a goal. The project config is loaded
 * as `run` loads it, the exploration body is registered in memory as the
 * run's only test, and within that test alone the explorer takes the place
 * of the agent the run uses, so the reporters, `report.json`,
 * artifacts, video, the AI trace, and the exit codes are the runner's own. The exploration's progress travels
 * as `explore` run events, which the list reporter renders, and its record
 * rides along as `run.explore`.
 */

import { MAX_PARAMS_BYTES } from '../agent/act-validation.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import { selectTargets } from '../collect/select.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig, type ResolvedCredential, type ResolvedTarget } from '../config/resolve.ts';
import { launchesPinnedApp } from '../config/targets.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ReportExplore } from '../report/build.ts';
import type { RunEventSink } from '../run/events.ts';
import type { RunnerOutput } from '../run/process-output.ts';
import { run, type RunOutcome } from '../run/runner.ts';
import { registerStaticSecrets, staticSecretLedger } from '../run/secrecy.ts';
import type { BuiltinReporter, E2EConfig, RecordingMode } from '../types.ts';
import { buildExplorer, EXPLORER_SOURCE_MODULE, explorerCount, explorerSource, type ExploreSpec } from './explorer.ts';
import { PARALLEL_BOUNDS, STEP_BOUNDS, TIMEOUT_BOUNDS } from './bounds.ts';
import { chooseFocuses } from './focus.ts';
import { requestGroups } from './merge.ts';
import type { PlanAccount } from './plan.ts';
import type { ExploreProgress } from './progress.ts';
import { ExploreRecord } from './record.ts';

const DEFAULT_GOAL = 'Explore the app and find bugs';
const MAX_GOAL_CHARS = 2_000;
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
  /**
   * Explorers to run at once, each with the whole goal and its own focus
   * (`--parallel`), 1 through 5; default 1. Each explorer is one test of the
   * run, in a worker process of its own, and has the step and time budgets
   * to itself; their findings are merged once all are over. With a config
   * value (`rawConfig`) they run one after another in this process.
   */
  readonly parallel?: number | undefined;
  /**
   * The explorers' own focuses (`--focus`), one per explorer, in place of the
   * built-in list; at most 5. Without `parallel`, the explorer count is their
   * number; with it, the two must match.
   */
  readonly focuses?: readonly string[] | undefined;
  readonly headed?: boolean | undefined;
  readonly reporters?: readonly BuiltinReporter[] | undefined;
  /** The results directory, `--output`, over the config's `output`. */
  readonly output?: string | undefined;
  readonly debug?: boolean | undefined;
  readonly aiTrace?: boolean | undefined;
  /** Which attempts keep a trace page, `--trace [mode]`; the exploration is one attempt, so a retry mode keeps none. */
  readonly trace?: RecordingMode | undefined;
  /** Which attempts record a video, `--video [mode]`; the exploration is one attempt, so a retry mode records nothing. */
  readonly video?: RecordingMode | undefined;
  readonly interruptSignal?: AbortSignal | undefined;
  readonly forceSignal?: AbortSignal | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * A config value instead of a discovered file, for the test harness: it may
   * hold a scripted model, which no config file could. `cwd` is the project
   * root then.
   */
  readonly rawConfig?: E2EConfig | undefined;
  /**
   * Notices decided before the run starts: the target chosen, a replaced
   * executor. Without it, the run emits them as `run` notices once it has
   * started, where `explore` on `e2e/runner` delivers them through `onEvent`.
   */
  readonly notice?: ((message: string) => void) | undefined;
  /** A second sink on the run's event spine, beside the reporters, as `run` takes. */
  readonly onEvent?: RunEventSink | undefined;
  /** Suppresses the list reporter, as `run` takes. */
  readonly quiet?: boolean | undefined;
  /**
   * The output a public run owns, as `run` takes: what user code prints is
   * redacted, and held while the config loads, until its secrets are known.
   */
  readonly processOutput?: RunnerOutput | undefined;
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
  const earlyNotices: string[] = [];
  const notice = options.notice ?? ((message: string) => void earlyNotices.push(message));
  const goal = resolveGoal(options.goal);
  const budgets = {
    maxSteps: resolveBounded(options.maxSteps, STEP_BOUNDS, 'maxSteps'),
    timeoutMs: resolveBounded(options.timeoutMs, TIMEOUT_BOUNDS, 'timeout'),
  };
  const parallel = options.parallel === undefined ? undefined : resolveBounded(options.parallel, PARALLEL_BOUNDS, 'parallel');

  // The config's secrets are known to the process before what its top-level
  // code printed is released, as `run` loads its config.
  const loadConfig = async (): Promise<LoadedConfig> => {
    const loaded = await loadRawConfig(options, cwd);
    const resolved = resolveConfig(loaded.raw, {
      projectRoot: loaded.projectRoot,
      env,
      cli: options.agent === undefined ? {} : { agents: [options.agent] },
    });
    registerStaticSecrets(resolved.allSecrets);
    return { ...loaded, resolved };
  };
  const { raw, projectRoot, configPath, resolved } = await (options.processOutput === undefined
    ? loadConfig()
    : options.processOutput.withholdDuring(loadConfig));
  const target = pickTarget(resolved.targets, options.target, notice);
  const accounts = credentialAccounts(resolved.credentials);
  // An exploration runs as exactly one agent: the one named, else `default`.
  const agentName = resolved.agentNames[0]!;
  if (agentName !== 'default') notice(`exploring with agent "${agentName}"`);

  const spec: ExploreSpec = {
    goal: redactGoal(goal, resolved.allSecrets),
    budgets,
    agentName,
    accounts,
    session: options.session,
    openApp: target.app.base !== undefined || launchesPinnedApp(target),
    focuses: chooseFocuses({
      focuses: options.focuses,
      parallel,
      platform: target.platform,
      otherAccount: accounts.length > 1 && options.session === undefined,
    }),
  };
  const explorers = explorerCount(spec);
  // Built once here, so a missing model fails before anything starts and a
  // replaced executor is told about once; the run builds its own.
  const sources = { entry: raw.agents?.[agentName], config: resolved };
  const merger = buildExplorer(spec, 1, sources, notice).resolved;
  const record = new ExploreRecord(spec, (findings, signal) =>
    requestGroups(findings, {
      adapter: createModelAdapter(merger.model, agentName),
      maxInputTokens: merger.maxInputTokens,
      providerOptions: merger.providerOptions,
      signal,
    }),
  );
  // Parallel explorers run in worker processes of their own, which load the
  // config file and build their explorer from the spec. A config value
  // cannot cross into one, so its explorers run here, one after another.
  const remote = explorers > 1 && configPath !== undefined
    ? { configPath, workers: explorers, source: { module: EXPLORER_SOURCE_MODULE, data: spec } }
    : undefined;
  if (remote === undefined && explorers > 1) {
    notice(`the config is a value, not a file, so the ${String(explorers)} explorers run one after another in this process`);
  }
  // The exploration is bounded by its own `--timeout`, not `maxDuration`.
  const { maxDuration: _maxDuration, ...runConfig } = raw;
  const outcome = await run({
    cwd: projectRoot,
    rawConfig: runConfig,
    agent: options.agent,
    env,
    tests: {
      source: {
        ...explorerSource(spec, sources),
        // Every explorer's moments reach the record as its unit's events; the
        // record puts them on the run's spine as `explore` events, merges the
        // findings once the run is over, and is the report's `run.explore`.
        start: (host) => record.subscribe((event) => host.emit({ type: 'explore', ...event })),
        receive: (file, event) => record.relay(file, event as ExploreProgress),
        finish: (host) => record.settle(host),
        report: () => ({ explore: record.snapshot() }),
      },
      notices: earlyNotices,
      ...(remote === undefined ? {} : { remote }),
    },
    targetIds: [target.name],
    headed: options.headed,
    reporters: options.reporters,
    output: options.output,
    debug: options.debug,
    aiTrace: options.aiTrace,
    trace: options.trace,
    video: options.video,
    interruptSignal: options.interruptSignal,
    forceSignal: options.forceSignal,
    onEvent: options.onEvent,
    quiet: options.quiet,
    processOutput: options.processOutput,
  });
  return { ...outcome, explore: record.snapshot() };
}

interface LoadedConfig {
  readonly raw: E2EConfig;
  readonly projectRoot: string;
  /** The file the config was loaded from; undefined for a config value. */
  readonly configPath: string | undefined;
  readonly resolved: ResolvedConfig;
}

/** The config as loaded: the value given, or the file discovered from `cwd`, with the file's path. */
async function loadRawConfig(options: ExploreOptions, cwd: string): Promise<Omit<LoadedConfig, 'resolved'>> {
  if (options.rawConfig !== undefined) return { raw: options.rawConfig, projectRoot: cwd, configPath: undefined };
  const discovered = discoverConfig(cwd, options.configPath);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  return { raw: await loadConfigModule(discovered.configPath), projectRoot: discovered.projectRoot, configPath: discovered.configPath };
}

function resolveGoal(goal: string | undefined): string {
  const trimmed = goal?.trim() ?? '';
  if (trimmed === '') return DEFAULT_GOAL;
  if (trimmed.length > MAX_GOAL_CHARS) {
    throw new ConfigurationError('INVALID_CONFIG', `the goal must be at most ${MAX_GOAL_CHARS} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

/**
 * The goal with every static secret value it spells out redacted. The goal
 * becomes the test's title, its artifact directory, the report's goal, and
 * model input, so it is redacted once, here, as a test file's titles are at
 * collection. A marker can be longer than the value it replaces, so the
 * ceiling is checked again on what the run will keep.
 */
function redactGoal(goal: string, secrets: ResolvedConfig['allSecrets']): string {
  const redacted = staticSecretLedger(secrets).redact(goal);
  if (redacted.length > MAX_GOAL_CHARS) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `the goal must be at most ${MAX_GOAL_CHARS} characters with its secret values redacted, got ${redacted.length}`,
    );
  }
  return redacted;
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
 * The accounts every charter carries, bounded to what a step parameter holds.
 * Measured as the step sees them: the usernames and the secret placeholders
 * the passwords become there.
 */
function credentialAccounts(credentials: ReadonlyMap<string, ResolvedCredential>): PlanAccount[] {
  const accounts = [...credentials.values()].map((credential) => ({ name: credential.name, username: credential.username }));
  const carried = Object.fromEntries(
    [...credentials.values()].map((credential) => [
      credential.name,
      { username: credential.username, password: { kind: 'secret', name: credential.password.name, purpose: 'password' } },
    ]),
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
