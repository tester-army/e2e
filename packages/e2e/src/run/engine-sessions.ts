/**
 * The engine side of one worker: the engine's init and dispose, and each
 * attempt's session from launch to close. The runner's `TargetExecutor` runs
 * tests on top of it; a standalone worker drives it directly.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { EngineDisposeContext, EngineSnapshot, ResolveSecretOptions } from '../engine/index.ts';
import type { TargetSession, OperationContext, VideoSegment } from '../engine/surface.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { classifyError, ConfigurationError, InfrastructureError, serializeError, translateEngineError, type SerializedError } from '../internal/errors.ts';
import { DebugTrace } from '../internal/debug.ts';
import { engineAppInfo } from '../config/app.ts';
import { NEVER_ABORTS, withScopedBudget } from '../internal/time.ts';
import { keeps, type AttemptRecordings, type VideoRecording } from '../internal/recording-modes.ts';
import type { Secret } from '../types.ts';
import { createEngineSession } from '../engine/session.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { AttemptRecord, RunError } from './records.ts';
import { adoptSecrets, registerDerivedSecrets, resolveSecretValue, sessionLedger } from './secrecy.ts';
import { isSecret } from '../secrets.ts';
import { targetIdentity, type SessionIdentity, type SessionStore } from './sessions.ts';
import { EngineError } from '../engine/contract.ts';
import { hostedVideoUrl } from '../engine/recording.ts';
import { sessionRecordings } from './recordings.ts';

/** What a worker's engine sessions need: the target, its config, and the worker's place in the run. */
export interface EngineSessionsOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly sessionStore: SessionStore;
  readonly headed: boolean;
  /** This worker's slot among the target's workers; see `EngineInitInfo.workerSlot`. */
  readonly workerSlot: number;
  /** This worker's environment; see `EngineInitInfo.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interruptSignal: AbortSignal;
  readonly debug?: DebugTrace;
  readonly events?: { onNotice?(message: string): void };
}

/**
 * The slice of an attempt record a session close reads and writes: the
 * verdict the caller has already reached, and the cleanup outcome the close
 * reports.
 */
export interface ClosingRecord {
  readonly status: AttemptRecord['status'];
  cleanup: AttemptRecord['cleanup'];
}

/**
 * What one attempt's session opens with: the saved session to restore, and
 * what the attempt captures (`pairRecordings`): the video it records, and
 * whether it keeps a trace, which decides whether screens are taken at all.
 */
export interface SessionPlan {
  readonly session: string | undefined;
  readonly recordings: AttemptRecordings;
}

/** What closing an attempt's session needs besides its verdict: the video it started. */
export interface SessionClose {
  readonly attemptId: string;
  readonly video: VideoRecording | undefined;
}

/** One worker's engine: init once, then one session per attempt. */
export class EngineSessions {
  readonly target: ResolvedTarget;
  get runId(): string {
    return this.options.runId;
  }
  readonly interruptSignal: AbortSignal;
  readonly debug: DebugTrace;

  protected readonly runErrors: RunError[] = [];
  protected readonly sessionIdentity: SessionIdentity;
  /** Resolves once the engine's init hook completed for this worker. */
  private engineReady: Promise<void> | undefined;

  constructor(protected readonly options: EngineSessionsOptions) {
    this.target = options.target;
    this.interruptSignal = options.interruptSignal;
    this.debug = options.debug ?? new DebugTrace(false);
    this.sessionIdentity = targetIdentity(options.target);
  }

  protected get config(): ResolvedConfig {
    return this.options.config;
  }

  /** Builds one engine operation context. */
  protected op(attemptId: string, timeoutMs: number, signal: AbortSignal): OperationContext {
    return { signal, timeoutMs, runId: this.options.runId, attemptId, origin: 'test' };
  }

  /** Run-level errors recorded so far, in order. */
  collectedRunErrors(): readonly RunError[] {
    return this.runErrors;
  }

  /**
   * Runs the engine's init hook once per worker, before the first session.
   * Boot work (simulators, device leases) is bounded by the launch timeout
   * but never charged against a step budget.
   */
  initEngineOnce(): Promise<void> {
    const engine = this.target.engine;
    const init = engine?.init?.bind(engine);
    if (init === undefined) return Promise.resolve();
    // Memoized for the worker's lifetime, failure included: an engine that
    // could not boot fails every attempt on this worker with the same cause
    // instead of re-running a broken boot per test. Init outlives any single
    // attempt, so it aborts on worker interrupt, not on one test's deadline.
    this.engineReady ??= this.debug.time('engine.init', () =>
      this.lifecycle(
        `initializing engine ${engine?.name ?? 'none'}`,
        this.config.launchTimeout,
        'LAUNCH_TIMEOUT',
        this.interruptSignal,
        (signal) =>
          init({
            runId: this.options.runId,
            targetName: this.target.name,
            projectRoot: this.config.projectRoot,
            app: engineAppInfo(this.target.app),
            env: this.options.env,
            headed: this.options.headed,
            workerSlot: this.options.workerSlot,
            signal,
            log: (line) => this.options.events?.onNotice?.(`${this.target.name} worker ${String(this.options.workerSlot)}: ${line}`),
          }),
      ),
    );
    return this.engineReady;
  }

  /**
   * Runs one lifecycle call on the engine seam within the given budget. The
   * signal handed to `run` follows `parent` and is aborted the moment the call
   * fails, timeout included, so a hook that outlived its budget is told to
   * stop instead of running on into the retry. Synchronous throws are caught,
   * and every failure is translated onto the runner taxonomy: an engine
   * failing outside its contract is infrastructure, never a test error.
   */
  protected async lifecycle<T>(
    label: string,
    timeoutMs: number,
    code: 'LAUNCH_TIMEOUT' | 'CLEANUP_TIMEOUT',
    parent: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await withScopedBudget(timeoutMs, parent, () => new InfrastructureError(code, `${label} timed out`), run);
    } catch (cause) {
      throw translateEngineError(cause, ` while ${label}`);
    }
  }

  /**
   * Disposes the engine at worker end of life, bounded by the cleanup budget.
   * Every engine runs over the protocol, whose client forwards `dispose` only
   * once `init` was called: a worker that never initialized opened no
   * connection, so the engine has nothing of it to release.
   */
  async dispose(options: Pick<EngineDisposeContext, 'reuseSignal'> = {}): Promise<void> {
    const disposeEngine = this.target.engine?.dispose?.bind(this.target.engine);
    if (disposeEngine === undefined) return;
    try {
      await this.lifecycle(
        'disposing the engine',
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => disposeEngine({ signal, timeoutMs: this.config.cleanupTimeout, ...options }),
      );
    } catch (cause) {
      this.runErrors.push({ error: serializeError(classifyError(cause), { phase: 'cleanup' }) });
    }
  }

  /** Starts one attempt on the engine, restores the planned session, and starts the planned video. */
  async launchSession(
    plan: SessionPlan,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<TargetSession> {
    // The engine booted in init() once per worker; the adapter is per-attempt
    // so refs never cross attempts.
    await this.initEngineOnce();
    const engine = this.target.engine;
    // Session restore rides the engine's neutral state capability. Checked
    // before any per-attempt isolation opens, so a misconfigured session never
    // orphans a started attempt.
    const sessionName = plan.session;
    if (sessionName !== undefined && engine?.state === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${this.target.name}" has no engine state capability for session restore`,
      );
    }
    const { video } = plan.recordings;
    const session = createEngineSession({ engine, targetName: this.target.name, traced: plan.recordings.trace !== undefined });
    const launch = <T>(label: string, run: (launchSignal: AbortSignal) => Promise<T>) =>
      this.lifecycle(label, this.config.launchTimeout, 'LAUNCH_TIMEOUT', signal, run);
    const launchOp = (launchSignal: AbortSignal) =>
      this.op(attemptId, this.config.launchTimeout, launchSignal);
    try {
      const startAttempt = engine?.startAttempt?.bind(engine);
      if (startAttempt !== undefined) {
        await this.debug.time('session.launch', () =>
          launch(`starting an attempt on engine ${engine?.name ?? 'none'}`, (launchSignal) =>
            startAttempt({
              attemptId,
              artifactsDir,
              signal: launchSignal,
              resolveSecret: (secret, options) => this.resolveEngineSecret(session, secret, options),
              appLog: (entry) => session.appLog.push(entry),
              navigation: (line) => session.appLog.navigated(line),
              ...(session.screens.traced ? { screen: (snapshot: EngineSnapshot) => session.screens.push(snapshot) } : {}),
              environment: (facts) => session.environment.push(facts),
            }),
          ),
        );
      }
      if (sessionName !== undefined) {
        const saved = await this.options.sessionStore.load(sessionName, this.sessionIdentity);
        // The values the saving session learned come back with its state, so
        // a stored value the app echoes is redacted here too.
        adoptSecrets(sessionLedger(session, this.config.allSecrets), saved.secrets);
        await launch('restoring the session', (launchSignal) =>
          session.restoreState!(saved.state, launchOp(launchSignal)),
        );
      }
      // A video the attempt asks for starts here, when the engine has it: an
      // engine without it was either refused before the run (a mode a target
      // or test set) or skipped with a notice (a run-wide mode). A required
      // video's failure fails the launch; a default one's is swallowed.
      if (video !== undefined && session.artifacts.startVideo !== undefined) {
        const recordings = sessionRecordings(session, this.target.name);
        const starting = launch('starting the video', (launchSignal) => recordings.startAttemptVideo(launchOp(launchSignal)));
        if (video.policy === 'required') await starting;
        else await starting.catch(() => undefined);
      }
    } catch (cause) {
      // The attempt's isolation is open, or a timed-out startAttempt may still
      // open it: end it within the cleanup budget, or the retry opens a second
      // one. An engine without startAttempt makes this a no-op.
      await this.endAttempt(session, attemptId).catch(() => undefined);
      throw cause;
    }
    return session;
  }

  /**
   * The plaintext of a secret the target's engine declared, for an option it
   * hands the app (basic-auth credentials). Registered for the session's and
   * the process's redaction by `resolveSecretValue`, with every value the
   * engine derives from it (the base64 credential an `Authorization` header
   * carries) under the same name, so its text and text downloads are
   * redacted of them. Its pixels stay as they are, since nothing was typed.
   */
  private async resolveEngineSecret(session: TargetSession, secret: Secret, options?: ResolveSecretOptions): Promise<string> {
    const engine = this.target.engine;
    if (!isSecret(secret) || !(engine?.secrets ?? []).some((declared) => declared.name === secret.name)) {
      const name = isSecret(secret) ? `"${secret.name}"` : 'a value that is not a secrets.get() handle';
      throw new ConfigurationError(
        'SECRET_UNAVAILABLE',
        `engine ${engine?.name ?? 'none'} asked for secret ${name}, which it did not declare in its secrets`,
      );
    }
    const ledger = sessionLedger(session, this.config.allSecrets);
    const plaintext = await resolveSecretValue(secret, this.config.allSecrets, ledger);
    registerDerivedSecrets(secret.name, (await options?.derived?.(plaintext)) ?? [], ledger);
    return plaintext;
  }

  /**
   * Collects a failure the engine holds from a path no step awaited, within
   * the cleanup budget; the interrupt is the one thing that cuts it short.
   * The error is the test's, thrown as it was so `classifyError` keeps its
   * code: `lifecycle` would name every non-engine error an engine failure.
   */
  settleAttempt(session: TargetSession, attemptId: string): Promise<void> {
    return withScopedBudget(
      this.config.cleanupTimeout,
      this.interruptSignal,
      () => new InfrastructureError('CLEANUP_TIMEOUT', 'settling the attempt timed out'),
      (signal) => session.settle(this.op(attemptId, this.config.cleanupTimeout, signal)),
    );
  }

  /** Ends one attempt's isolation within the cleanup budget. */
  private endAttempt(session: TargetSession, attemptId: string): Promise<void> {
    return this.lifecycle(
      'ending the attempt',
      this.config.cleanupTimeout,
      'CLEANUP_TIMEOUT',
      NEVER_ABORTS,
      (signal) => session.close(this.op(attemptId, this.config.cleanupTimeout, signal)),
    );
  }

  /**
   * Finalizes the video, then ends the attempt with a fresh cleanup
   * budget. The caller has classified the attempt by now: `record.status`
   * decides whether an `on-failure` recording is kept.
   */
  async closeSession(
    session: TargetSession,
    close: SessionClose,
    record: ClosingRecord,
    artifactSink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void> {
    const { attemptId, video } = close;
    await this.stopRunningRecording(session, attemptId, record, artifactSink, secondaryErrors);
    if (session.artifacts.stopVideo !== undefined && video !== undefined) {
      const recordings = sessionRecordings(session, this.target.name);
      await this.stopVideo(video, attemptId, record, secondaryErrors, async (operation) => {
        const segments = await recordings.stopAttemptVideo(operation);
        // Recorded so a failure could be looked at; a pass has nothing to show.
        if (!keeps(video.keep, record.status)) {
          await Promise.all(
            segments.flatMap((segment) => ('path' in segment ? [rm(path.join(artifactSink.dir, segment.path), { force: true })] : [])),
          );
          return;
        }
        registerVideos(artifactSink, segments);
      });
    }
    try {
      await this.debug.time('session.close', () => this.endAttempt(session, attemptId));
    } catch (cause) {
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

  /**
   * Stops a recording the test started with `app.startRecording` and left
   * running, within the cleanup budget, and keeps it as the attempt's
   * artifact. One that cannot be finalized is a cleanup failure.
   */
  protected async stopRunningRecording(
    session: TargetSession,
    attemptId: string,
    record: ClosingRecord,
    artifactSink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void> {
    const recordings = sessionRecordings(session, this.target.name);
    if (!recordings.spanRunning) return;
    try {
      await this.lifecycle(
        'stopping the recording',
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => recordings.stopSpan(this.op(attemptId, this.config.cleanupTimeout, signal), artifactSink),
      );
    } catch (cause) {
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

  /**
   * Stops the video the attempt started, within the cleanup budget. A
   * required video that cannot be finalized is a cleanup failure the report
   * must show; a best-effort one fails quietly.
   */
  private async stopVideo(
    recording: VideoRecording,
    attemptId: string,
    record: ClosingRecord,
    secondaryErrors: SerializedError[],
    stop: (operation: OperationContext) => Promise<void>,
  ): Promise<void> {
    try {
      await this.lifecycle(
        'stopping the video',
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => stop(this.op(attemptId, this.config.cleanupTimeout, signal)),
      );
    } catch (cause) {
      if (recording.policy !== 'required') return;
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

}

/**
 * The status of a failed attempt. An interrupt outranks everything except a
 * timeout that had already fired: the attempt then timed out, whatever
 * arrived after.
 */
export function classifyAttemptStatus(
  failure: { readonly code: string },
  timedOut: boolean,
  interrupted: boolean,
): 'failed' | 'timed-out' | 'interrupted' {
  if (interrupted && !timedOut) return 'interrupted';
  if (timedOut || failure.code === 'TEST_TIMEOUT') {
    return 'timed-out';
  }
  return 'failed';
}

/**
 * Registers an attempt's kept recordings, in order: a file under its path, a
 * link by URL. An engine's own link is held to what a provider's is, an
 * http(s) URL; one that is not fails the cleanup once every other recording
 * is registered, so it costs no other video.
 */
function registerVideos(sink: ArtifactSink, segments: readonly VideoSegment[]): void {
  const rejected: string[] = [];
  for (const segment of segments) {
    if ('path' in segment) {
      sink.register('video', segment.path, { startedAt: segment.startedAt });
      continue;
    }
    const url = hostedVideoUrl(segment.url);
    if (url === undefined) rejected.push(JSON.stringify(segment.url));
    else sink.link(url, { mediaType: segment.mediaType, startedAt: segment.startedAt });
  }
  if (rejected.length > 0) {
    throw new EngineError('ENGINE_FAILURE', `the engine returned a video link that is not an http(s) URL: ${rejected.join(', ')}`, { retryable: false });
  }
}