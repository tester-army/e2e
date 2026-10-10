/**
 * `openSession` on `e2e/runner`: one e2e session opened from another test runner.
 * A host (Playwright Test, Vitest, Jest, a custom harness) keeps its own
 * collection, retries, and reporting, and borrows what e2e owns per attempt:
 * the target's engine provisioning and device or browser leasing, the
 * fixture graph (`agent`, `app`, `screen`, and what the engine contributes),
 * secret redaction, and cleanup. This is the same attempt `e2e mcp` opens; a
 * host gets its fixtures instead of a tool catalog.
 */

import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { ConfigurationError, type SerializedError } from '../internal/errors.ts';
import { resolveConfig, type ResolvedConfig, type ResolvedTarget } from '../config/resolve.ts';
import { allocateAppPorts } from './app-ports.ts';
import { registerStaticSecrets } from './secrecy.ts';
import { openStandaloneAttempt } from './standalone.ts';
import type { StepProgress, StepRecord } from './steps.ts';
import type { E2EConfig, TestFixtures } from '../types.ts';

export interface OpenSessionOptions {
  /** Directory the config is looked up from, and the project root of a config value; default `process.cwd()`. */
  readonly cwd?: string | undefined;
  /**
   * A config file path relative to `cwd`, or a config value in place of a
   * file; default the nearest `e2e.config.ts` from `cwd` upward. A file is
   * loaded fresh, with the files it imports, so every session gets engine
   * instances of its own. A value's engine instances are shared by every
   * session opened from it: open those one at a time, or give sessions open
   * at once a value each.
   */
  readonly config?: string | E2EConfig | undefined;
  /** Target to open by name; may be left out when the config declares one target. */
  readonly target?: string | undefined;
  /** Configured agent the `agent` fixture runs as when a call names none; default the config's first. */
  readonly agent?: string | undefined;
  /** The session's environment, where config, engines, and providers read secrets; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Cancels the session wherever it is: provisioning, launch, or a fixture call. */
  readonly signal?: AbortSignal | undefined;
  /** Deadline of fixture calls in milliseconds, counted from when the session opens; default the config's `timeout`. It neither bounds opening (use `signal`) nor closes the session. */
  readonly timeout?: number | undefined;
  /** Runs a browser engine headed. */
  readonly headed?: boolean | undefined;
  /**
   * Live progress of every step the session runs, the same feed `e2e run`
   * reporters get as `step` events: a step opening, its events and
   * activities, and its end with status, duration, and redacted error.
   * Must not block or throw.
   */
  readonly onStep?: ((progress: StepProgress) => void) | undefined;
  /** One line of progress outside any step: engine provisioning, a leased device, an app process. */
  readonly onNotice?: ((target: string, message: string) => void) | undefined;
}

/** One open session: a test attempt with no test body, driven by the host. */
export interface E2ESession<Fixtures extends object = Record<string, unknown>> extends AsyncDisposable {
  readonly runId: string;
  readonly attemptId: string;
  /** The target the session runs on, by name. */
  readonly target: string;
  /** `agent`, `app`, `screen`, `platform`, and the engine's fixtures (`browser`, `device`). */
  readonly fixtures: TestFixtures & Fixtures;
  /** Absolute directory the session's artifacts (screenshots, recordings) are written to. */
  readonly artifactsDir: string;
  /** The steps run so far, finished ones and the one running, as the report records them. */
  steps(): readonly StepRecord[];
  /**
   * Ends the session: closes the engine session, releases leased devices or
   * browsers, stops app processes, and resolves with the cleanup failures
   * instead of throwing them. Idempotent. Disposing the session
   * (`await using`) closes it the same way and throws an `AggregateError` of
   * those failures instead.
   */
  close(): Promise<readonly SerializedError[]>;
}

/**
 * Opens one session on a target of the project's config. On any failure
 * everything that did start is torn down before the error surfaces.
 *
 * ```ts
 * import { openSession } from 'e2e/runner';
 * import type { Device } from '@e2e-dev/mobile';
 *
 * await using session = await openSession<{ device: Device }>({ target: 'android' });
 * await session.fixtures.agent.act('open settings and turn on dark mode');
 * ```
 */
export async function openSession<Fixtures extends object = Record<string, unknown>>(
  options: OpenSessionOptions = {},
): Promise<E2ESession<Fixtures>> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const loaded = await loadSessionConfig(cwd, options.config, env);
  // Known to the process before anything can fail with one, as in a run.
  registerStaticSecrets(loaded.allSecrets);
  // A session is its own run: a URL declared with port 0 gets a port here,
  // for the opened target alone, so another target's URL cannot fail the open.
  const selected = resolveTarget(loaded, options.target);
  const config = await allocateAppPorts(loaded, [selected.name]);
  const target = config.targets.find((candidate) => candidate.name === selected.name) ?? selected;
  const attempt = await openStandaloneAttempt({
    config,
    target,
    headed: options.headed ?? false,
    env,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeout ?? config.timeout,
    agent: options.agent,
    ...(options.onNotice === undefined ? {} : { notice: options.onNotice }),
    ...(options.onStep === undefined ? {} : { onProgress: options.onStep }),
  });
  const close = (): Promise<readonly SerializedError[]> => attempt.close();
  return {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    target: target.name,
    fixtures: attempt.fixtures as TestFixtures & Fixtures,
    artifactsDir: attempt.artifactsDir,
    steps: () => attempt.steps.all(),
    close,
    // `await using` has no result to hand back, so cleanup failures are thrown instead of dropped.
    [Symbol.asyncDispose]: async () => {
      const failures = await close();
      if (failures.length > 0) {
        throw new AggregateError(failures, `closing the e2e session failed: ${failures.map((failure) => failure.message).join('; ')}`);
      }
    },
  };
}

/**
 * A config value resolves against `cwd`, as `list` resolves it. A file is
 * loaded fresh down to the files it imports, as `e2e mcp` loads it: a host
 * opens sessions in one long-lived process, and each needs engine instances
 * of its own, even from a config that spreads a base config.
 */
async function loadSessionConfig(cwd: string, config: string | E2EConfig | undefined, env: NodeJS.ProcessEnv): Promise<ResolvedConfig> {
  if (typeof config === 'object') return resolveConfig(config, { projectRoot: cwd, env });
  const discovered = discoverConfig(cwd, config);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  const raw = await loadConfigModule(discovered.configPath, { graph: true });
  return resolveConfig(raw, { projectRoot: discovered.projectRoot, configPath: discovered.configPath, env });
}

function resolveTarget(config: ResolvedConfig, name: string | undefined): ResolvedTarget {
  const names = config.targets.map((target) => `"${target.name}"`).join(', ');
  if (name !== undefined) {
    const target = config.targets.find((candidate) => candidate.name === name);
    if (target === undefined) throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${name}"; the config declares ${names}`);
    return target;
  }
  const [only] = config.targets;
  if (only === undefined) throw new ConfigurationError('INVALID_CONFIG', 'the config declares no targets');
  if (config.targets.length > 1) throw new ConfigurationError('TARGET_REQUIRED', `the config declares several targets (${names}); pass \`target\` to openSession`);
  return only;
}
