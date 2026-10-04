/**
 * Shared per-phase machinery for agent step execution. `Invocation` (the
 * locate/judgment tier) and `ActDispatch` (the executor socket) both compose
 * these, so event recording, `--debug` buckets, tracing, deadline semantics,
 * and observation race-hardening cannot drift between the two paths.
 */

import type { Observation, OperationContext } from '../engine/surface.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { asEngineError, isE2EError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { POLL_INTERVAL_MS, sleep, type Deadline } from '../internal/time.ts';
import type { LocatorEngine } from '../locator/engine.ts';
import type { StepActivity, StepEvent, StepRecorder } from '../run/steps.ts';
import { AgentError, toAgentError } from './error.ts';

/**
 * One engine operation's budget: `actionTimeout`, capped by the step clock.
 * Bounding each call independently is what keeps a single screen that never
 * settles from consuming the whole step: the hang costs one action timeout and
 * a clearly attributed failure, not the test budget.
 */
export function boundedOperation(
  engine: LocatorEngine,
  actionTimeout: number,
  deadline: Deadline,
): OperationContext {
  return { ...engine.operation(Math.max(1, Math.min(actionTimeout, deadline.remaining()))), origin: 'agent' };
}

/** Records one policy decision as a child event of the current step. */
export function recordPolicyEvent(
  steps: StepRecorder,
  name: string,
  decision: 'allowed' | 'denied',
  code?: string,
): void {
  steps.recordEvent({
    kind: 'policy',
    startedAt: timestamp(),
    durationMs: 0,
    status: decision === 'allowed' ? 'passed' : 'failed',
    name,
    decision,
    ...(code === undefined ? {} : { code }),
  });
}

/** The step recorder and optional debug trace a phase reports into. */
export interface PhaseHost {
  readonly steps: StepRecorder;
  readonly debug?: DebugTrace | undefined;
}

/** One instrumented phase: the event kind it records and the debug bucket it feeds. */
export interface PhaseSpec {
  /** Public API name of the enclosing step, e.g. `agent.assert`. */
  readonly api: string;
  readonly kind: StepEvent['kind'];
  readonly phase: 'agent.observe' | 'agent.model' | 'agent.action' | 'agent.cache';
  readonly name?: string;
}

/** The live activity a phase announces as it begins; a cache probe announces nothing. */
const ACTIVITY_BY_PHASE: Readonly<Record<PhaseSpec['phase'], StepActivity | undefined>> = {
  'agent.observe': 'observe',
  'agent.model': 'model',
  'agent.action': 'action',
  'agent.cache': undefined,
};

/**
 * Runs one phase with uniform accounting: the activity announced as it
 * begins, a child event on success and failure, one debug bucket, and
 * translation onto the closed agent error set. Every observe/model/action
 * phase of every agent step goes through here so the records cannot drift
 * apart.
 */
export async function instrumentPhase<Value>(
  host: PhaseHost,
  spec: PhaseSpec,
  body: () => Promise<Value>,
  detail?: (value: Value) => Partial<StepEvent>,
): Promise<Value> {
  const startedAt = timestamp();
  const startedMs = Date.now();
  const activity = ACTIVITY_BY_PHASE[spec.phase];
  if (activity !== undefined) host.steps.activity(activity);
  try {
    const value = await body();
    const eventDetail = detail?.(value);
    host.steps.recordEvent({
      kind: spec.kind,
      startedAt,
      durationMs: Date.now() - startedMs,
      status: 'passed',
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...eventDetail,
    });
    return value;
  } catch (cause) {
    const error = toAgentError(cause);
    host.steps.recordEvent({
      kind: spec.kind,
      startedAt,
      durationMs: Date.now() - startedMs,
      status: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
      ...(spec.name === undefined ? {} : { name: spec.name }),
      code: phaseErrorCode(cause),
    });
    throw error;
  } finally {
    host.debug?.record(spec.phase, Date.now() - startedMs);
  }
}

/**
 * Fails when the step clock has run out.
 *
 * `cause` carries the failure that was being handled when the clock was found
 * to be out, so a step that timed out mid-operation still says what the
 * operation reported, and decides the clock question when that failure is an
 * operation timeout within one poll tick of the deadline: `boundedOperation`
 * gave such an operation the deadline's remaining time, so its timer and the
 * deadline mark one instant on two clocks, and the timer, on the event loop's
 * clock, fires first under load while `Date.now()` still reads the deadline as
 * a few milliseconds away. Running out of that budget is the step running out.
 * An operation that times out on its own, with time to spare, keeps its code.
 */
export function checkStepClock(options: {
  readonly signal: AbortSignal;
  readonly deadline: Deadline;
  readonly api: string;
  readonly timeoutMs: number;
  readonly cause?: unknown;
}): void {
  const detail = options.cause === undefined ? {} : { cause: options.cause };
  if (options.signal.aborted) {
    throw new AgentError('CANCELLED', `${options.api} was cancelled`, detail);
  }
  if (options.deadline.expired() || timedOutAtDeadline(options.cause, options.deadline)) {
    throw new AgentError(
      'STEP_TIMEOUT',
      `${options.api} exceeded its ${options.timeoutMs} ms timeout`,
      detail,
    );
  }
}

/** True when `cause` is an operation timeout and the deadline is less than one poll tick away. */
function timedOutAtDeadline(cause: unknown, deadline: Deadline): boolean {
  return deadline.remaining() < POLL_INTERVAL_MS && asEngineError(cause)?.code === 'OPERATION_TIMEOUT';
}

/**
 * Captures one raw observation, re-capturing while the engine reports a
 * retryable failure and the step clock allows. A screen that navigates as it is
 * read (a redirect, a hydration swap, a form submit still committing) makes
 * the capture lose its document; that is a race, not a broken app, so it is
 * re-read rather than surfaced as a failed call. `guard` is the caller's
 * clock check, so a capture that outlives the deadline reports the step's own
 * timeout rather than whichever transport error the truncated budget produced.
 * `fallbackTainted` marks a step that would accept fallback pixels but for a
 * secret fill: its semantic capture timing out before the step clock does is
 * the policy denial it is, not an engine timeout, since only those pixels
 * could have answered.
 */
export async function retryingObserve(options: {
  readonly observe: (operation: OperationContext) => Promise<Observation>;
  readonly operation: () => OperationContext;
  readonly guard: (cause?: unknown) => void;
  readonly signal: AbortSignal;
  readonly api: string;
  readonly fallbackTainted: boolean;
}): Promise<Observation> {
  for (;;) {
    try {
      return await options.observe(options.operation());
    } catch (cause) {
      options.guard(cause);
      if (options.fallbackTainted && asEngineError(cause)?.code === 'OPERATION_TIMEOUT') {
        throw new AgentError(
          'POLICY_DENIED',
          `${options.api} could not read the semantic tree, and its screenshot fallback is denied: ` +
            'a secret was filled in this attempt, so no pixels leave the runner until it ends (PIXEL_TAINTED)',
          { cause },
        );
      }
      // Structural, not instanceof: an engine a config file imported lives in
      // another module registry, and its retryable race would otherwise fail
      // the observation the moment a page navigates under it.
      const engineError = asEngineError(cause);
      if (engineError === undefined || !engineError.retryable) {
        throw cause;
      }
      await sleep(POLL_INTERVAL_MS, options.signal);
    }
  }
}

/** Event code for a failed phase: the runner or engine code, or the error's name. */
function phaseErrorCode(cause: unknown): string {
  if (isE2EError(cause)) return cause.code;
  const engineError = asEngineError(cause);
  if (engineError !== undefined) return engineError.code;
  return cause instanceof Error ? cause.name : 'ERROR';
}
