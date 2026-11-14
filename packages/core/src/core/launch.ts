/**
 * `launch` from `e2e-core`: drive a browser or a device from plain code, with
 * no test runner, config file, or report. A host is one worker on one engine
 * instance: it prepares the engine, initializes it, and opens sessions on it
 * one at a time. Parallel work is more hosts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectConfig, type ResolvedConfig, type ResolvedTarget } from '../config/resolve.ts';
import type { EngineHandle } from '../engine/index.ts';
import { classifyError, ConfigurationError, E2EError, InfrastructureError, serializeError, TestError } from '../internal/errors.ts';
import { rejectUnknownOptions } from '../internal/options.ts';
import { MAX_TIMER_MS } from '../internal/time.ts';
import { redactOpening } from '../run/redact-opening.ts';
import { processSecrets, registerStaticSecrets, sessionLedger } from '../run/secrecy.ts';
import { targetIdentity } from '../run/sessions.ts';
import { openCoreHost, type StandaloneHost } from '../run/standalone.ts';
import type { StandaloneAttempt } from '../run/standalone-attempt.ts';
import { secretHandle } from '../secrets.ts';
import type { App, Screen, Secret, TargetApp } from '../types.ts';
import { FailureWatch, registerSession } from './internals.ts';
import { closeOnSignals } from './signals.ts';
import { restoredStateFor, SessionState, type StateIdentity } from './state.ts';

/** What every session holds, whatever its engine. */
export interface CoreFixtures {
  /** Semantic queries and the actions on their matches. */
  readonly screen: Screen;
  /** App lifecycle: open, restart, clear state, back, screenshot, recording. */
  readonly app: App;
  /** The engine's platform label: `web`, `ios`, `android`, or an engine's own string. */
  readonly platform: string;
}

/** The app a host drives: what `app.open()` opens on a browser, or launches on a device. */
export type LaunchApp = Pick<TargetApp, 'url' | 'bundleId' | 'appPath' | 'linkBase' | 'identity' | 'launchArguments' | 'permissions'>;

export interface LaunchOptions {
  /** The app: `url` on a browser; `bundleId` or `appPath` on a device, and `linkBase` for `app.open(path)` there. */
  readonly app?: LaunchApp | undefined;
  /**
   * Secret values by name, at least 6 characters each. Fill one through
   * `host.secret(name)`; an agent receives it by name only. The values are
   * redacted from every error and screen reading this host produces.
   */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** Shows the browser window; default false. Devices ignore it. */
  readonly headed?: boolean | undefined;
  /**
   * Default timeout of one operation in milliseconds (an action, a wait, a
   * read). Default 30000 for actions and 5000 for waits and reads, the
   * runner's. A session changes it with `setDefaultTimeout`. There is no
   * session deadline.
   */
  readonly timeout?: number | undefined;
  /** Cancels opening the host, and every session and operation on it. Closing still releases what it opened. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Closes the host on SIGINT, SIGTERM, and SIGHUP, so the browser or device
   * session it launched does not outlive the program; default true. The
   * signal is raised again afterwards unless the program listens for it.
   */
  readonly handleSignals?: boolean | undefined;
  /**
   * Where screenshots, downloads, and recordings are written. Default: a
   * fresh directory under the system temp directory, deleted when the host
   * closes.
   */
  readonly artifactsDir?: string | undefined;
  /** The directory upload paths and relative files resolve against; default `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** The environment the engine reads; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Progress outside operations: provisioning, downloads, device leases. Must not throw. */
  readonly onNotice?: ((message: string) => void) | undefined;
}

export interface NewSessionOptions {
  /** A state `saveState()` captured, or `SessionState.import()` read, on a host of the same engine, platform, and app. */
  readonly state?: SessionState | undefined;
  /** Cancels opening the session and every operation on it. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One isolated session: a browser context, or the app on a device. Holds
 * `screen`, `app`, `platform`, and what the engine contributes (`browser`,
 * `device`).
 */
export type Session<Fixtures extends object = {}> = CoreFixtures & Fixtures & SessionControls;

/** The methods every session has beside its fixtures. */
export interface SessionControls extends AsyncDisposable {
  /** Captures the session's state (cookies, storage, app data) in memory. Persist it only with `export({ key })`. */
  saveState(): Promise<SessionState>;
  /** The default timeout of operations started from now on, in milliseconds: actions, waits, and reads. */
  setDefaultTimeout(timeout: number): void;
  /** Ends the session. Idempotent. Throws an `AggregateError` of the failures closing found, such as a cleanup that did not finish. */
  close(): Promise<void>;
}

/** One engine instance, initialized: the owner of the sessions opened on it, one at a time. */
export interface Host<Fixtures extends object = {}> extends AsyncDisposable {
  /** The engine's platform label: `web`, `ios`, `android`, or an engine's own string; its name when it declares none. */
  readonly platform: string;
  /** The handle of a secret passed to `launch`, for `fill` or an agent's params. An unknown name throws `SECRET_UNAVAILABLE`. */
  secret(name: string): Secret;
  /** Opens a session. One at a time: the previous one must be closed. */
  newSession(options?: NewSessionOptions): Promise<Session<Fixtures>>;
  /** Closes the open session, then the engine. Idempotent. Throws an `AggregateError` of the failures closing found. */
  close(): Promise<void>;
}

const LAUNCH_OPTION_KEYS = ['app', 'secrets', 'headed', 'timeout', 'signal', 'handleSignals', 'artifactsDir', 'cwd', 'env', 'onNotice'] as const;
const SESSION_OPTION_KEYS = ['state', 'signal'] as const;
/** The fixtures every session exposes; the engine's own join them. */
const CORE_FIXTURES = ['screen', 'app', 'platform'] as const;

/**
 * Launches `engine`: prepares it (a first-run browser download, a device
 * lease), initializes one worker, and returns the host that opens sessions
 * on it. Each `launch` needs its own engine instance: `launch(web())`.
 */
export async function launch<Fixtures extends object = {}>(engine: EngineHandle<Fixtures>, options: LaunchOptions = {}): Promise<Host<Fixtures>> {
  rejectUnknownOptions('launch', options, LAUNCH_OPTION_KEYS);
  const timeout = options.timeout;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new TestError('INVALID_ARGUMENT', 'launch timeout must be a positive integer number of milliseconds');
  }
  const ownsArtifacts = options.artifactsDir === undefined;
  const output = options.artifactsDir === undefined ? await mkdtemp(path.join(os.tmpdir(), 'e2e-core-')) : path.resolve(options.artifactsDir);
  const removeOutput = (): Promise<void> => ownsArtifacts ? rm(output, { recursive: true, force: true }) : Promise.resolve();
  let opened: { readonly config: ResolvedConfig; readonly target: ResolvedTarget; readonly host: StandaloneHost };
  try {
    opened = await redactOpening(async () => {
      const env = options.env ?? process.env;
      const resolved = resolveProjectConfig(
        {
          // An engine that declares no platform labels its host with its name.
          targets: [{ engine, ...(engine.platform === undefined ? { platform: engine.name } : {}), ...(options.app === undefined ? {} : { app: options.app }) }],
          trace: 'off',
          video: 'off',
          cache: 'off',
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
          ...(timeout === undefined ? {} : { actionTimeout: timeout, assertionTimeout: timeout }),
        },
        { projectRoot: path.resolve(options.cwd ?? process.cwd()), env },
      );
      // Set past resolution, which keeps a run's output inside its project: a host's lives where the program says.
      const config: ResolvedConfig = { ...resolved, output };
      registerStaticSecrets(config.allSecrets);
      const target = config.targets[0]!;
      const notice = options.onNotice;
      const host = await openCoreHost({
        config, target, env, headed: options.headed ?? false,
        signal: options.signal ?? new AbortController().signal,
        ...(notice === undefined ? {} : { notice: (_target: string, message: string) => notice(message) }),
      });
      return { config, target, host };
    });
  } catch (cause) {
    await removeOutput();
    throw cause;
  }
  const { config, target, host } = opened;
  const identity: StateIdentity = {
    engine: target.engine?.name ?? 'none',
    platform: target.platform,
    appIdentity: targetIdentity(target).appIdentity,
  };
  let closing: Promise<void> | undefined;
  /** The open session's close, so the host closes it the way a program would, its agents' recordings settled. */
  let closeOpen: (() => Promise<void>) | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      unregister();
      const errors: { readonly code: string; readonly message: string; readonly category: string }[] = [];
      try {
        await closeOpen?.();
      } catch (cause) {
        errors.push(...(cause instanceof AggregateError ? cause.errors as E2EError[] : [classifyError(cause)]));
      }
      errors.push(...await host.close());
      await removeOutput().catch(() => undefined);
      throwClosingErrors(errors, 'closing the host');
    })();
    return closing;
  };
  const unregister = options.handleSignals === false ? () => undefined : closeOnSignals(close);
  return {
    platform: target.platform,
    secret: (name: string) => {
      const registered = typeof name === 'string' ? config.allSecrets.get(name) : undefined;
      if (registered === undefined) {
        const known = [...config.allSecrets.keys()];
        throw new ConfigurationError('SECRET_UNAVAILABLE', `secret ${JSON.stringify(name)} was not passed to launch; ${known.length === 0 ? 'it was given no secrets' : `it has ${known.join(', ')}`}`);
      }
      return secretHandle({ name, purpose: registered.purpose });
    },
    newSession: (sessionOptions = {}) => redactOpening(async () => {
      rejectUnknownOptions('newSession', sessionOptions, SESSION_OPTION_KEYS);
      if (closing !== undefined) throw new InfrastructureError('WORKER_PROTOCOL', 'the host is closed');
      const state = sessionOptions.state === undefined ? undefined : restoredStateFor(sessionOptions.state, identity);
      const failures = new FailureWatch();
      const attempt = await host.openAttempt({
        signal: sessionOptions.signal ?? new AbortController().signal,
        // No session deadline: each operation keeps its own timeout.
        timeoutMs: MAX_TIMER_MS,
        onProgress: failures.onProgress,
        ...(state === undefined ? {} : { state }),
      });
      failures.watch(attempt.steps);
      const session = coreSession<Fixtures>(attempt, config, identity, target, failures, () => {
        if (closeOpen === session.close) closeOpen = undefined;
      });
      closeOpen = session.close;
      return session;
    }),
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** The session over one attempt: its fixtures, and the controls a program needs without a test around it. */
function coreSession<Fixtures extends object>(
  attempt: StandaloneAttempt,
  config: ResolvedConfig,
  identity: StateIdentity,
  target: ResolvedTarget,
  failures: FailureWatch,
  onClosed: () => void,
): Session<Fixtures> {
  const { fixtures } = attempt;
  const engine = attempt.agentRuntime.engine;
  const closers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const errors = [];
      for (const closer of closers) {
        try { await closer(); } catch (cause) { errors.push(serializeError(classifyError(cause), { phase: 'cleanup', redact: processSecrets.redact })); }
      }
      errors.push(...await attempt.close());
      onClosed();
      throwClosingErrors(errors, 'closing the session');
    })();
    return closing;
  };
  const controls: SessionControls = {
    // An engine's capture failure reaches the program through the same sanitized boundary as an opening's.
    saveState: () => redactOpening(async () => {
      if (attempt.session.captureState === undefined) {
        throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `engine ${identity.engine} has no state capability, so a session on it cannot be saved`);
      }
      const state = await attempt.session.captureState(engine.operation());
      // Every value the session knows, configured ones too: the state may restore on a host launched without them.
      return SessionState.captured(identity, state, sessionLedger(attempt.session, config.allSecrets).entries());
    }),
    setDefaultTimeout: (timeout: number) => {
      if (!Number.isInteger(timeout) || timeout <= 0) throw new TestError('INVALID_ARGUMENT', 'setDefaultTimeout takes a positive integer number of milliseconds');
      engine.setDefaultTimeouts({ action: timeout, assertion: timeout });
    },
    close,
    [Symbol.asyncDispose]: close,
  };
  // Built property by property: the fixtures are accessors, each acquired on first touch, and their names come from the engine.
  const session: Session<Fixtures> = Object.create(null);
  for (const name of [...CORE_FIXTURES, ...Object.keys(target.engine?.fixtures ?? {})]) {
    Object.defineProperty(session, name, { enumerable: true, get: () => Reflect.get(fixtures, name) as unknown });
  }
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(controls));
  const typed = Object.freeze(session);
  registerSession(typed, {
    attempt, config, target, closers,
    // A cancelled session implicates nothing, so its recordings are neither written nor evicted.
    settlement: () => attempt.budget.signal.aborted ? undefined : failures.settlement(attempt.steps),
  });
  return typed;
}

/** Throws what closing found, redacted, as one `AggregateError`; nothing when it found nothing. */
function throwClosingErrors(errors: readonly { readonly code: string; readonly message: string; readonly category: string }[], what: string): void {
  if (errors.length === 0) return;
  const thrown = errors.map((error) => new E2EError(error.category as E2EError['category'], error.code, error.message));
  throw new AggregateError(thrown, `${what} failed: ${thrown.map((error) => error.message).join('; ')}`);
}
