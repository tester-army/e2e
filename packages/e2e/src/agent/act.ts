/**
 * The planning tier: `agent.act` (spec 02-test-api.md, 10-determinism.md).
 *
 * There is no outer agent loop. One `act` is one bounded invocation that repeats
 * a single cycle — observe, ask for the next action, authorize it, commit it —
 * until the model concludes or a budget runs out. The model never reaches the
 * driver: it answers with one `agent-tool-1` object, the runner validates it
 * against the action space and the security policy, and only then dispatches.
 *
 * This file owns the loop and nothing else. The vocabulary lives in
 * `action-space.ts` and the prose in `prompts.ts`, so adding an action or
 * rewording a rule never touches the control flow.
 */

import type { CacheLocator } from '../cache/index.ts';
import type { SemanticNode } from '../driver/index.ts';
import { asDriverError, TestError } from '../internal/errors.ts';
import { agentTrace } from '../internal/trace.ts';
import { isSecret } from '../locator/screen.ts';
import type {
  AgentErrorCode,
  AgentParam,
  AgentParams,
  Secret,
  StandardSchemaV1,
} from '../types.ts';
import {
  actRequest,
  describeCall,
  describeRecordedAction,
  dispatch,
  offeredKinds,
  toolSchemaFor,
  validateToolCall,
  type ActionContext,
  type ToolCall,
} from './action-space.ts';
import { AgentError } from './error.ts';
import type { AgentContext, Invocation } from './invocation.ts';
import { toAgentError } from './invocation.ts';
import { observationShape } from './observation.ts';
import { openPathCache, type OpenPathCache } from './path-cache.ts';
import {
  challengeNotice,
  describeBudget,
  NAVIGATION_WITHDRAWN_NOTICE,
  stalledNotice,
} from './prompts.ts';
import type { ProtocolValidation } from './protocol.ts';
import { storableForNode } from './storable.ts';

/**
 * Consecutive failed actions tolerated before the invocation gives up.
 *
 * A failed action is worth reporting back rather than aborting on: a control
 * covered by a toast, or a node that went stale as the page settled, is
 * something the model can route around once it is told. But a model that cannot
 * land an action three times running is not converging, and spending the
 * remaining budget on it only delays the same failure.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Dispatches abandoned to a mid-flight re-render before it counts as a failure.
 *
 * A page that restages on every interaction would otherwise loop, so the
 * allowance is small; the model-call budget bounds it regardless.
 */
const MAX_STALE_RETRIES = 3;

/**
 * Actions remaining below which the model is told to start wrapping up.
 *
 * A flow that does not know it is running out spends its last steps opening
 * something new rather than reporting what it found, and the author gets a bare
 * budget error instead of a conclusion.
 */
const WIND_DOWN_AT = 3;

/** Instruction bounds after NFC, per 02-test-api.md. */
const MIN_INSTRUCTION_BYTES = 1;
const MAX_INSTRUCTION_BYTES = 8 * 1024;

/** Canonical non-secret parameter bounds, per 02-test-api.md. */
const MAX_PARAM_BYTES = 64 * 1024;
const MAX_PARAM_DEPTH = 32;

/** Trail entries kept, and the bytes they may occupy in a request. */
const MAX_TRAIL_ENTRIES = 40;
const MAX_TRAIL_BYTES = 4096;

/** Outcome of one `act` invocation, before the caller's schema is applied. */
export interface ActConclusion {
  readonly explanation: string;
  readonly data: unknown;
}

/**
 * Runs the planning loop until the model concludes.
 *
 * `onData` validates a proposed conclusion payload. Returning an issue rejects
 * the conclusion and re-prompts while budget remains, which is what makes the
 * schema overload's `data` a checked value rather than whatever the model said.
 */
export async function runAct(
  invocation: Invocation,
  runtime: AgentContext,
  request: {
    readonly instruction: string;
    /** Already-disclosed parameters, validated before the step began. */
    readonly disclosed: DisclosedParams;
    readonly testIdAttribute: string;
    readonly onData?: (value: unknown) => Promise<ProtocolValidation<unknown>>;
  },
): Promise<ActConclusion> {
  // `'only'` withholds the tree, and every action but scroll, press, and
  // navigate has to name a node from it. A planning call under it could only
  // ever propose targets the runner rejects, so it is refused before a model
  // call rather than after the budget is gone. Same code the located methods
  // that need a node use (spec/api/e2e.d.ts VisionMode).
  if (invocation.treeWithheld) {
    throw new AgentError(
      'POLICY_DENIED',
      "agent.act cannot run with vision: 'only': planning names nodes from the observation, " +
        "which that mode withholds. Use vision: true to add a screenshot alongside the tree.",
    );
  }
  const disclosed = request.disclosed;
  const context: ActionContext = {
    invocation,
    runtime,
    secrets: disclosed.secrets,
    operation: () => invocation.operation(),
  };
  const locate = (target: SemanticNode): CacheLocator | undefined =>
    storableForNode(target, request.testIdAttribute);

  const trail = new Trail();
  const stalls = new StallGuard();
  const failures = new FailureBudget();
  let round = 0;
  /** `used/limit` prefix, so every line says which budget it is spending. */
  const progress = (): string =>
    `${String(invocation.maxActionSteps - invocation.actionStepsRemaining)}/${String(invocation.maxActionSteps)}`;

  // The first observation is taken outside the loop because the path cache key
  // is screen-scoped and has to be built from it: the same instruction on a
  // different screen is a different call, and keying it otherwise would offer a
  // checkout path to a settings page. Opening once also keeps `cache` a constant
  // — lazily assigning it inside the loop silently re-opened it every round for
  // a bypassed cache, whose result is `undefined`.
  let observation = await invocation.observe();
  const cache: OpenPathCache | undefined = await openPathCache(invocation, observation, {
    instruction: request.instruction,
    input: disclosed.key,
  });

  let repair: { issue: string; rawText: string | undefined } | undefined;
  let notice: string | undefined;
  /** Whether a failure conclusion has already been questioned this invocation. */
  let challenged = false;
  /** Whether the model has been told navigation is gone; said once, not per round. */
  let navigationExplained = false;

  // A planning loop that is not converging looks identical from outside to one
  // that is merely slow, so the deadline reports how far it actually got.
  try {
    for (;;) {
      round += 1;
      // Round one already has one. Every later round re-reads the screen, which
      // is what makes guidance advisory and a conclusion checkable.
      if (round > 1) observation = await invocation.observe();

      const offered = offeredKinds({
        actionStepsRemaining: invocation.actionStepsRemaining,
        committed: invocation.dispatched,
      });
      // Said once, and only when there is room to say it: a pending notice from
      // the previous round is more urgent, and deferring keeps both.
      if (
        notice === undefined &&
        !navigationExplained &&
        invocation.dispatched &&
        !offered.includes('navigate')
      ) {
        navigationExplained = true;
        notice = NAVIGATION_WITHDRAWN_NOTICE;
      }
      const suggestion = cache?.next();
      const guidance = suggestion === undefined ? undefined : describeRecordedAction(suggestion);
      const startedMs = Date.now();
      const call = await invocation.ask({
        schemaName: 'agent-tool-1',
        schema: toolSchemaFor(offered),
        // The observation is part of the grammar for this one call: an id it does
        // not contain is not a target, it is invalid output worth one repair.
        validate: (value) => validateToolCall(value, observation, offered),
        prompt: {
          request: actRequest(offered),
          budget: describeBudget({
            actions: invocation.actionStepsRemaining,
            calls: invocation.modelCallsRemaining,
            windDownAt: WIND_DOWN_AT,
          }),
          instruction: request.instruction,
          observation,
          ...(disclosed.text === undefined ? {} : { params: disclosed.text }),
          ...(trail.isEmpty() ? {} : { trail: trail.render() }),
          ...(guidance === undefined ? {} : { guidance }),
          ...(notice === undefined ? {} : { notice }),
          ...(repair === undefined ? {} : { repair }),
        },
      });
      repair = undefined;
      notice = undefined;

      if (call.control === 'conclude') {
        agentTrace(() => `${progress()} done ${call.status} · ${firstLine(call.explanation)}`);
        // A first failure with budget left is questioned once, never accepted
        // silently. Bounded to a single challenge so a genuine dead end costs one
        // extra round rather than the whole budget.
        if (
          call.status === 'failure' &&
          !challenged &&
          invocation.actionStepsRemaining > 0 &&
          invocation.canAsk()
        ) {
          challenged = true;
          // The model reports the screen cannot do what was asked, which is the
          // signal `'fallback'` waits for: the tree did not describe what it
          // needed. Pixels join every later request in this invocation.
          const escalated = invocation.canEscalateVision();
          if (escalated) invocation.escalateVision();
          agentTrace(
            () =>
              `${progress()} gave up — asked to look again first` +
              `${escalated ? ', now with a screenshot' : ''}`,
          );
          trail.note(`reported "${firstLine(call.explanation)}" and was asked to look again`);
          notice = challengeNotice({
            explanation: firstLine(call.explanation),
            actionsRemaining: invocation.actionStepsRemaining,
            screenshotAttached: escalated,
          });
          continue;
        }
        const conclusion = await concludeOrRepair(invocation, trail, call, request.onData);
        if (conclusion.ok) {
          // Only a completely successful invocation writes guidance.
          await cache?.write();
          return conclusion.value;
        }
        repair = conclusion.repair;
        continue;
      }

      // An observation is driver-only work, so it costs a model call and the
      // clock but never an action step. The next round observes anyway, so there
      // is nothing further to do here.
      if (call.control === 'observe') {
        agentTrace(() => `${progress()} look again`);
        trail.note('looked at the screen again');
        continue;
      }

      const shape = observationShape(observation);
      const signature = describeCall(call, observation);
      const stall = stalls.check(shape, signature);
      if (stall.decision === 'abort') {
        throw new AgentError(
          'STEP_NO_CONCLUSION',
          `agent.act proposed ${signature} on an unchanged screen ${String(stall.seen)} times without concluding`,
        );
      }
      if (stall.decision === 'skip') {
        // Not dispatched. A control that produced no visible change may be doing
        // async work, and repeating a submit or a purchase is exactly the mistake
        // that must not be made on the caller's behalf. The model gets told what
        // the runner sees and chooses again.
        agentTrace(() => `${progress()} ${signature} — skipped, screen unchanged`);
        trail.note(`proposed ${signature} again with the screen unchanged; not repeated`);
        notice = stalledNotice(signature);
        continue;
      }

      const derivative = call.action.path?.record(call.args as never, locate);
      cache?.reconcile(derivative);

      try {
        await dispatch(context, call);
        cache?.committed(derivative);
        trail.succeeded(signature);
        failures.landed();
        agentTrace(() => `${progress()} ${signature} — ok ${Date.now() - startedMs}ms`);
      } catch (cause) {
        const error = toAgentError(cause);
        // A denied action is a policy decision about what the model asked for,
        // not a transient obstacle, so it ends the invocation rather than being
        // handed back as something to route around.
        if (TERMINAL_CODES.has(error.code)) throw error;
        invocation.checkDeadline(cause);
        // The page re-rendered between the observation and the dispatch, so the
        // node the model named no longer exists. Nothing was performed and
        // nothing was wrong with the decision: the next round reads the new
        // document and asks again. Charging an action step for it would let a
        // busy page spend the budget without ever acting, and telling the model
        // to "try something different" would send it away from a correct target.
        if (isStaleNode(cause) && failures.allowStale(MAX_STALE_RETRIES)) {
          invocation.refundActionStep();
          // The action never ran, so proposing it again is the right move rather
          // than a repetition: forget the runner ever saw it.
          stalls.forget(shape, signature);
          trail.note(`${signature} did not run: the page changed first`);
          agentTrace(() => `${progress()} ${signature} — page moved, re-reading`);
          continue;
        }
        if (failures.failed(MAX_CONSECUTIVE_FAILURES)) throw error;
        trail.failed(signature, error.message);
        agentTrace(() => `${progress()} ${signature} — failed ${error.code}, rerouting`);
      }
    }
  } catch (cause) {
    throw explainProgress(invocation, cause, trail, round);
  }
}

/**
 * Whether the runner should perform a proposed action, given what it has already
 * watched fail to move the screen.
 *
 * Every (screen shape, action) pair the invocation has proposed is remembered,
 * not just the previous round's. A model that has lost the thread does not repeat
 * itself back to back — it cycles: it taps something, looks, taps the same thing
 * again from the other side of an `observe`, or alternates between two controls
 * that both do nothing. Remembering only the last round meant every one of those
 * loops ran to the end of the budget while the runner reported nothing unusual.
 *
 * A pair is a genuine repeat only when the *rendered* screen is identical, which
 * already excludes any action that had a visible effect, so there is no
 * legitimate flow this rejects: doing the same thing to the same screen twice
 * cannot produce a different result the second time.
 */
type StallDecision = 'proceed' | 'skip' | 'abort';

class StallGuard {
  private readonly counts = new Map<string, number>();

  /** Records a proposal and says what to do with it. */
  check(shape: string, action: string): { decision: StallDecision; seen: number } {
    const key = StallGuard.key(shape, action);
    const seen = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, seen);
    // The second proposal is answered rather than performed, because a control
    // doing async work looks exactly like one doing nothing. A third is a loop.
    const decision: StallDecision = seen === 1 ? 'proceed' : seen === 2 ? 'skip' : 'abort';
    return { decision, seen };
  }

  /** Drops a proposal that never reached the application. */
  forget(shape: string, action: string): void {
    const key = StallGuard.key(shape, action);
    const seen = this.counts.get(key) ?? 0;
    if (seen <= 1) this.counts.delete(key);
    else this.counts.set(key, seen - 1);
  }

  private static key(shape: string, action: string): string {
    return `${action}\u0000${shape}`;
  }
}

/**
 * How much failure one invocation tolerates before it stops.
 *
 * The two counters belong together because they are the same question asked of
 * different evidence: a dispatch the driver reports as retryable proved nothing
 * was sent and costs neither a step nor blame, while anything else is a real
 * obstacle the model gets one chance to route around.
 */
class FailureBudget {
  private consecutive = 0;
  private stale = 0;

  /** Notes a committed action, which clears everything before it. */
  landed(): void {
    this.consecutive = 0;
    this.stale = 0;
  }

  /** True while a re-render may still be retried for free. */
  allowStale(limit: number): boolean {
    if (this.stale >= limit) return false;
    this.stale += 1;
    return true;
  }

  /** Records a real failure. True once the invocation should give up. */
  failed(limit: number): boolean {
    this.consecutive += 1;
    return this.consecutive >= limit;
  }
}

/**
 * Attaches what the flow managed to do to any failure coming out of the loop.
 *
 * Every way an `act` can fail reports the operation that happened to be running
 * at the time — a timed-out model call, a rejected response, a repeated action —
 * and none of them say whether the flow was three steps from done or had been
 * stuck since the first round. A multi-action flow that fails is unreadable
 * without that, so the trail travels with the error and is also recorded on the
 * step, where the report keeps it after the message has scrolled away.
 *
 * Applied to every code rather than a chosen few: the codes worth explaining are
 * exactly the ones nobody predicted, and a list would keep missing them.
 */
function explainProgress(
  invocation: Invocation,
  cause: unknown,
  trail: Trail,
  round: number,
): AgentError {
  const error = toAgentError(cause);
  if (error.code === 'CANCELLED') return error;
  const summary = trail.isEmpty()
    ? `agent.act stopped in planning round ${round} without committing any action`
    : `agent.act stopped in planning round ${round}; it got as far as:\n${trail.render()}`;
  invocation.note({ explanation: summary });
  return new AgentError(error.code, `${error.message}\n\n${summary}`, {
    cause: error,
    ...(error.screenshot === undefined ? {} : { screenshot: error.screenshot }),
  });
}

/** Failures that end the invocation instead of becoming trail feedback. */
const TERMINAL_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'POLICY_DENIED',
  'CANCELLED',
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'STEP_TIMEOUT',
  'STEP_BUDGET_EXHAUSTED',
]);

/** Validates one conclusion, and its schema payload when the caller wants one. */
async function concludeOrRepair(
  invocation: Invocation,
  trail: Trail,
  call: Extract<ToolCall, { control: 'conclude' }>,
  onData: ((value: unknown) => Promise<ProtocolValidation<unknown>>) | undefined,
): Promise<
  | { ok: true; value: ActConclusion }
  | { ok: false; repair: { issue: string; rawText: string | undefined } }
> {
  invocation.note({ explanation: call.explanation });
  if (call.status === 'failure') {
    // Recorded on the trail as well as raised, so the summary the failure carries
    // ends with the agent's own account of why it gave up.
    trail.note(`gave up: ${call.explanation}`);
    throw new AgentError('ACTION_FAILED', `agent.act could not finish: ${call.explanation}`);
  }
  if (onData === undefined) {
    return { ok: true, value: { explanation: call.explanation, data: undefined } };
  }
  const validation = await onData(call.data);
  if (validation.ok) {
    return { ok: true, value: { explanation: call.explanation, data: validation.value } };
  }
  invocation.recordSchemaRejection('agent-tool-1');
  if (!invocation.canAsk()) {
    throw new AgentError(
      'MODEL_OUTPUT_INVALID',
      `agent.act concluded with data that failed schema validation: ${validation.issue}`,
    );
  }
  return { ok: false, repair: { issue: validation.issue, rawText: safeJson(call.data) } };
}

/**
 * What this invocation has already done.
 *
 * Bounded on both entries and bytes, oldest dropped first, for the reason the
 * ledger is: it is model input that grows with every step, and a long flow must
 * not be able to spend the request budget on its own history.
 *
 * Without it the model has no memory inside one invocation — every round sees a
 * fresh observation and nothing else — and would re-propose the action it just
 * committed. The ledger cannot serve here because it is built from *completed
 * steps*, and one `act` is a single step that has not completed yet.
 */
class Trail {
  private readonly entries: string[] = [];
  private dropped = 0;

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  succeeded(action: string): void {
    this.push(action);
  }

  failed(action: string, reason: string): void {
    this.push(`${action} — FAILED: ${firstLine(reason)}`);
  }

  note(text: string): void {
    this.push(text);
  }

  private push(entry: string): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_TRAIL_ENTRIES) {
      this.entries.shift();
      this.dropped += 1;
    }
  }

  render(): string {
    const encoder = new TextEncoder();
    const lines: string[] = [];
    let bytes = 0;
    let dropped = this.dropped;
    // Fill newest-first so the byte limit drops the oldest entries, then print
    // chronologically: the order the steps happened in is what the model reads.
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const line = `${index + 1 + this.dropped}. ${this.entries[index] ?? ''}`;
      const size = encoder.encode(`${line}\n`).byteLength;
      if (lines.length > 0 && bytes + size > MAX_TRAIL_BYTES) {
        dropped = index + 1 + this.dropped;
        break;
      }
      bytes += size;
      lines.push(line);
    }
    lines.reverse();
    if (dropped > 0) lines.unshift(`(${dropped} earlier step(s) omitted)`);
    return lines.join('\n');
  }
}

/**
 * Renders call parameters for the model, and collects the secrets among them.
 *
 * A plain value is disclosed. A `Secret` is represented by its name and purpose
 * only, and the same walk builds the map of which secrets this call may fill:
 * being named in `<parameters>` is exactly what authorizes a later fill, so the
 * disclosure and the authority come from one place and cannot disagree.
 */
export interface DisclosedParams {
  readonly text: string | undefined;
  /** The same redacted values, as the canonical cache-key input. */
  readonly key: Readonly<Record<string, unknown>>;
  readonly secrets: ReadonlyMap<string, Secret>;
}

/**
 * Called before the step opens, so a malformed argument fails the test that wrote
 * it rather than being reported as a policy denial. `POLICY_DENIED` is
 * configuration-category and would change the run's exit code from 1 to 2, which
 * CI reads as a misconfigured project rather than a failing test.
 */
export function discloseParams(params: AgentParams | undefined): DisclosedParams {
  const secrets = new Map<string, Secret>();
  if (params === undefined) return { text: undefined, key: {}, secrets };
  const redacted = walkParam(params, secrets, 0);
  const text = JSON.stringify(redacted, undefined, 2);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_PARAM_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act parameters are ${bytes} bytes, over the ${MAX_PARAM_BYTES} byte limit`,
    );
  }
  return { text, key: redacted as Readonly<Record<string, unknown>>, secrets };
}

function walkParam(value: AgentParam, secrets: Map<string, Secret>, depth: number): unknown {
  if (depth > MAX_PARAM_DEPTH) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act parameters nest deeper than ${MAX_PARAM_DEPTH} levels`,
    );
  }
  if (isSecret(value)) {
    secrets.set(value.name, value);
    // The placeholder names the secret and says what it is for. It never carries
    // the value, and its shape mirrors what a `type` call must send back, so the
    // model has no reason to invent a different one.
    return { secret: value.name, purpose: value.purpose };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkParam(entry, secrets, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, walkParam(entry, secrets, depth + 1)]),
    );
  }
  return value;
}

/** Normalizes and bounds one instruction, per 02-test-api.md. */
export function normalizeInstruction(api: string, instruction: string): string {
  if (typeof instruction !== 'string') {
    throw new TestError('INVALID_ARGUMENT', `${api} requires a string instruction`);
  }
  const normalized = instruction.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes < MIN_INSTRUCTION_BYTES || bytes > MAX_INSTRUCTION_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} instruction must be ${MIN_INSTRUCTION_BYTES} through ${MAX_INSTRUCTION_BYTES} bytes after NFC, got ${bytes}`,
    );
  }
  return normalized;
}

/** Bounds a caller's `maxSteps` against the resolved configuration limit. */
export function resolveSteps(requested: number | undefined, limit: number): number {
  if (requested === undefined) return limit;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', 'maxSteps must be a positive integer');
  }
  if (requested > limit) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `maxSteps ${requested} exceeds the resolved limit ${limit}`,
    );
  }
  return requested;
}

/**
 * Validates a proposed conclusion payload against the caller's schema, shaped as
 * a protocol validation so `runAct` can feed the issue back as a repair round.
 */
export async function validateConclusionData(
  schema: StandardSchemaV1,
  value: unknown,
  describeIssue: (issue: StandardSchemaV1.Issue) => string,
): Promise<ProtocolValidation<unknown>> {
  const validation = await schema['~standard'].validate(value);
  if (validation.issues === undefined) return { ok: true, value: validation.value };
  return { ok: false, issue: validation.issues.map(describeIssue).join('; ') };
}

/**
 * Whether a dispatch failed because the page replaced the node under it.
 *
 * Walks the cause chain, because the driver's error is wrapped onto the closed
 * agent code set before it reaches here and only the original carries the
 * `retryable` flag that says nothing was dispatched. Recognized with
 * `asDriverError` rather than `instanceof`: a driver imported by a config file
 * loads through a different module registry, so its `DriverError` is a different
 * class and would never match.
 */
function isStaleNode(cause: unknown): boolean {
  for (let error: unknown = cause; error instanceof Error; error = error.cause) {
    const driverError = asDriverError(error);
    if (driverError !== undefined) return driverError.retryable;
  }
  return false;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? text).trim().slice(0, 200);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
