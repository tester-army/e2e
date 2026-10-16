/** Hosted test runners keep a worker alive while opening isolated per-test attempts. */

import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { classifyError, ConfigurationError, E2EError, serializeError, type SerializedError } from '../internal/errors.ts';
import type { E2EConfig, Report, TestFixtures } from '../types.ts';
import { allocateTargetPorts } from './app-ports.ts';
import { processSecrets, registerStaticSecrets } from './secrecy.ts';
import { selectTarget } from './select-target.ts';
import { openStandaloneHost } from './standalone.ts';
import type { StepProgress, StepRecord } from './steps.ts';
import { reserveHostedRun } from './public-ownership.ts';

export interface OpenHostOptions {
  /** Config search directory, or project root of a config value; default `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Path relative to `cwd`, or a config value; default nearest `e2e.config.ts`. Files load fresh per host. */
  readonly config?: string | E2EConfig | undefined;
  /** May be omitted only when the config declares one target. */
  readonly target?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Cancels provisioning, initialization, and every session's operations. Close still releases resources. */
  readonly signal?: AbortSignal | undefined;
  readonly headed?: boolean | undefined;
  /** Progress outside steps: provisioning, leases, and app processes. Must not throw. */
  readonly onNotice?: ((target: string, message: string) => void) | undefined;
}

export interface OpenSessionOptions {
  /** Test title, treated as untrusted text, never a raw path component. */
  readonly name: string;
  /**
   * Deadline for the session's operations in milliseconds, counted from when
   * it opens; default the config's `timeout`. Positive and finite. Expiry cuts
   * running operations and fails the session as timed out; it does not bound
   * opening (use `signal`) and does not close the session.
   */
  readonly timeout?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly agent?: string | undefined;
  /** The same step progress feed reporters receive. Must not block or throw. */
  readonly onStep?: ((progress: StepProgress) => void) | undefined;
}

export interface E2EHost<Fixtures extends object = Record<string, unknown>> extends AsyncDisposable {
  readonly runId: string;
  readonly target: string;
  /** One opening, live, or closing hosted session per process; open sequentially. */
  openSession(options: OpenSessionOptions): Promise<E2ESession<Fixtures>>;
  /** Cancels/ends a pending or active session, then disposes the worker and releases resources once. */
  close(): Promise<readonly SerializedError[]>;
}

export interface E2ESession<Fixtures extends object = Record<string, unknown>> extends AsyncDisposable {
  readonly runId: string;
  readonly attemptId: string;
  readonly target: string;
  readonly fixtures: TestFixtures & Fixtures;
  readonly artifactsDir: string;
  /** Absolute per-session trace path. Written before close settles successfully. */
  readonly tracePath: string;
  steps(): readonly StepRecord[];
  /** The session Report after close and a successful trace write; otherwise undefined. */
  report(): Report | undefined;
  /** Idempotent. Returns soft assertion, abandoned-operation, and cleanup failures. Disposal throws them as AggregateError. */
  close(): Promise<readonly SerializedError[]>;
}

/** Opens the worker-scoped owner of preparation, app processes, and engine initialization. */
export async function openHost<Fixtures extends object = Record<string, unknown>>(
  options: OpenHostOptions = {},
): Promise<E2EHost<Fixtures>> {
  return redactOpening(() => openHostWorker<Fixtures>(options));
}

/** Loads the selected target and opens its worker behind the redacted public boundary. */
async function openHostWorker<Fixtures extends object>(options: OpenHostOptions): Promise<E2EHost<Fixtures>> {
  const release = reserveHostedRun();
  try {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const loaded = await loadHostConfig(cwd, options.config, env);
    registerStaticSecrets(loaded.allSecrets);
    const { config, target } = await allocateTargetPorts(loaded, selectTarget(loaded, options.target, 'pass `target` to openHost'));
    const host = await openStandaloneHost({
      config, target, headed: options.headed ?? false, env,
      signal: options.signal ?? new AbortController().signal,
      ...(options.onNotice === undefined ? {} : { notice: options.onNotice }),
    });
    const close = async (): Promise<readonly SerializedError[]> => {
      try {
        return await host.close();
      } finally {
        release();
      }
    };
    return {
      runId: host.runId, target: target.name, close,
      [Symbol.asyncDispose]: () => dispose(close, 'host'),
      openSession: (sessionOptions) => redactOpening(async () => {
        if (typeof sessionOptions.name !== 'string') throw new ConfigurationError('INVALID_CONFIG', 'a hosted session requires a string name');
        const attempt = await host.openAttempt({
          name: sessionOptions.name,
          signal: sessionOptions.signal ?? new AbortController().signal,
          timeoutMs: sessionOptions.timeout ?? config.timeout,
          agent: sessionOptions.agent,
          ...(sessionOptions.onStep === undefined ? {} : { onProgress: sessionOptions.onStep }),
        });
        return {
          runId: attempt.runId, attemptId: attempt.attemptId, target: target.name,
          fixtures: attempt.fixtures as TestFixtures & Fixtures,
          artifactsDir: attempt.artifactsDir, tracePath: attempt.tracePath,
          steps: () => attempt.steps.all(), report: attempt.report, close: attempt.close,
          [Symbol.asyncDispose]: () => dispose(attempt.close, 'session'),
        };
      }),
    };
  } catch (cause) {
    release();
    throw cause;
  }
}

/** Opening errors go straight to the external runner, never through a report writer. */
async function redactOpening<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (cause) {
    const classified = classifyError(cause);
    const safe = serializeError(classified, { redact: processSecrets.redact });
    // Arbitrary engine causes can carry non-text secret data; only the sanitized record crosses out.
    const error = safe.category === 'configuration'
      ? new ConfigurationError(safe.code, safe.message, safe.details === undefined ? {} : { details: safe.details })
      : new E2EError(safe.category, safe.code, safe.message, {
        retryable: safe.retryable, ...(safe.details === undefined ? {} : { details: safe.details }),
      });
    error.name = processSecrets.redact(classified.name);
    if (safe.stack !== undefined) error.stack = safe.stack;
    throw error;
  }
}

/** `await using` has no result to return; it throws failures rather than dropping them. */
async function dispose(close: () => Promise<readonly SerializedError[]>, owner: string): Promise<void> {
  const failures = await close();
  if (failures.length > 0) throw new AggregateError(failures, `closing the e2e ${owner} failed: ${failures.map((failure) => failure.message).join('; ')}`);
}

/** Each host gets fresh file-config engine instances; a value resolves against cwd. */
async function loadHostConfig(cwd: string, config: string | E2EConfig | undefined, env: NodeJS.ProcessEnv): Promise<ResolvedConfig> {
  if (typeof config === 'object') return resolveConfig(config, { projectRoot: cwd, env });
  const discovered = discoverConfig(cwd, config);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  const raw = await loadConfigModule(discovered.configPath, { graph: true });
  return resolveConfig(raw, { projectRoot: discovered.projectRoot, configPath: discovered.configPath, env });
}
