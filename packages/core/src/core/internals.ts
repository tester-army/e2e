/**
 * What `e2e-core/agent` reads off a session it did not create: the attempt
 * behind it, the host's config, and the session's close hooks. Module-private
 * state behind a WeakMap, so a session object carries none of it.
 */

import { MODEL_UNREACHABLE_CODES } from '../agent/error.ts';
import type { AttemptSettlement } from '../cache/context.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { TestError } from '../internal/errors.ts';
import type { StandaloneAttempt } from '../run/standalone-attempt.ts';
import type { StepProgress, StepRecorder } from '../run/steps.ts';

export interface SessionInternals {
  readonly attempt: StandaloneAttempt;
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  /** Run in order when the session closes, before its attempt ends: an agent settles its replay cache here. */
  readonly closers: (() => Promise<void>)[];
  /** How the session's steps went, as the replay cache settles what its agents recorded; undefined once it was cancelled. */
  readonly settlement: () => AttemptSettlement | undefined;
}

/**
 * Watches a session's steps for its first agent step that failed, as a run's
 * attempt watches for its failure: recordings are confirmed up to the check
 * that passed before it, and a failure only a missing model explains
 * implicates none of them.
 */
export class FailureWatch {
  private steps: StepRecorder | undefined;
  private failure: { readonly lastVerified: number; readonly implicates: boolean } | undefined;

  /** The `onProgress` hook the session's attempt reports its steps to. */
  readonly onProgress = (progress: StepProgress): void => {
    // Only an agent step's failure implicates recordings: a program catches a locator's timeout on purpose, to branch.
    if (progress.phase !== 'end' || progress.kind !== 'agent' || progress.status === 'passed' || this.failure !== undefined || this.steps === undefined) return;
    const code = progress.error?.code;
    this.failure = { lastVerified: this.steps.lastVerifiedStepIndex, implicates: code === undefined || !MODEL_UNREACHABLE_CODES.has(code) };
  };

  watch(steps: StepRecorder): void {
    this.steps = steps;
  }

  settlement(steps: StepRecorder): AttemptSettlement {
    return this.failure === undefined
      ? { lastVerifiedStepIndex: steps.lastVerifiedStepIndex, implicatesUnconfirmed: true }
      : { lastVerifiedStepIndex: this.failure.lastVerified, implicatesUnconfirmed: this.failure.implicates };
  }
}

const sessions = new WeakMap<object, SessionInternals>();

/** Records the internals of a session `launch` created. */
export function registerSession(session: object, internals: SessionInternals): void {
  sessions.set(session, internals);
}

/** The internals of a session `launch` created; anything else is `INVALID_ARGUMENT`. */
export function sessionInternals(session: unknown, api: string): SessionInternals {
  const internals = typeof session === 'object' && session !== null ? sessions.get(session) : undefined;
  if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} takes a session from host.newSession()`);
  return internals;
}
