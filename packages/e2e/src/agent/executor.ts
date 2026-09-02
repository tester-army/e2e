/**
 * The step-executor socket (RFC0001, layer 4).
 *
 * The harness owns each `agent.act()` step — observation, action dispatch,
 * budgets, recording, and verdict mapping — and delegates only the thinking to
 * a pluggable executor. Swapping executors changes the thinking, never safety,
 * budgets, or the report.
 *
 * This module never imports the AI SDK: a hand-rolled executor with no AI SDK
 * is a valid implementation. The AI-SDK golden path lives in
 * `default-agent.ts` behind the same interface.
 *
 * Trust model: an executor is trusted project code, in the same trust domain
 * as the config module that constructed it — it may hold its own model and
 * credentials. What the harness enforces against it is not secrecy but
 * accounting: budgets, deadlines, recording, and the verdict grammar hold no
 * matter whose brain runs the step.
 */

import type { AgentErrorCode, JsonValue, ModelInstance, Platform, ScrollDirection, Secret } from '../types.ts';
import { AGENT_CODE_TABLE } from './error.ts';

export type { BlockedCategory } from './error.ts';
export { blockedCategoryOf } from './error.ts';

/**
 * One step handed to an executor. `act` plans and executes a flow; `assert`
 * judges a condition and must not change application state.
 */
export interface ExecutorStep {
  readonly kind: 'act' | 'assert';
  /** The natural-language instruction or assertion the test passed. */
  readonly instruction: string;
  /**
   * JSON-safe call parameters. A `Secret` value in the caller's params is
   * projected to `{ kind: 'secret', name, purpose }` — the plaintext never
   * reaches the executor; it fills fields only through `actions.typeSecret`.
   */
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
  /** Secrets declared in the params, fillable via `actions.typeSecret`. */
  readonly secrets: readonly { readonly name: string; readonly purpose: Secret['purpose'] }[];
}

/** Redacted, size-bounded observation an executor may show its model. */
export interface ExecutorObservation {
  readonly revision: string;
  /** One node per line as `#id role "name" ...`; already secret-redacted. */
  readonly text: string;
  readonly truncated: boolean;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
}

/** A node named by its id from the newest observation, e.g. `{ id: 'n42' }`. */
export interface ExecutorTarget {
  readonly id: string;
}

/**
 * The action grammar. Every executor action bottoms out here, where the
 * harness enforces the deadline, the action budget, origin policy, and
 * recording. Node ids are only valid against the newest observation; a stale
 * id fails the action rather than acting on the wrong node. Actions and
 * observations are serialized in call order: a call issued while another is
 * in flight queues behind it and resolves its target against the newest
 * observation, so concurrency can never soften the staleness rule. A
 * committed mutation does not mint a new observation: ids from the newest
 * observation stay addressable afterward (batching independent targets — a
 * form fill — is legitimate), the backend rejects references it can no longer
 * bind (`NODE_STALE`), and the mutation's effects are visible only through a
 * fresh `observe()`.
 */
export interface ExecutorActions {
  tap(target: ExecutorTarget): Promise<void>;
  type(target: ExecutorTarget, value: string): Promise<void>;
  /**
   * Fills one secret declared in the step's params into a secure input. The
   * harness authorizes the fill (registered credential, origin policy, an
   * editable sink whose purpose matches) and hands the plaintext straight to
   * the backend — it never passes through the executor or any model.
   */
  typeSecret(target: ExecutorTarget, name: string): Promise<void>;
  press(target: ExecutorTarget, key: string): Promise<void>;
  select(target: ExecutorTarget, value: string): Promise<void>;
  scroll(direction: ScrollDirection, target?: ExecutorTarget): Promise<void>;
  /** Navigates within the configured allowed origins. */
  navigate(url: string): Promise<void>;
}

/** Usage detail of one executor-made model call, all fields optional. */
export interface ExecutorModelCall {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly provider?: string;
  readonly modelId?: string;
  /** Billed cost of this call in USD, when the provider reports one. */
  readonly estimatedCostUsd?: number;
}

/** Step budgets, read and reported by the executor, enforced by the harness. */
export interface ExecutorBudgets {
  readonly maxActions: number;
  readonly maxModelCalls: number;
  actionsUsed(): number;
  remainingMs(): number;
  /**
   * Records one executor-made model call. Reported usage feeds the step
   * metrics, the report's model provenance, and `--debug` accounting.
   * Throws `STEP_BUDGET_EXHAUSTED` once the call count exceeds
   * `maxModelCalls`: the budget is enforced, not advisory.
   */
  recordModelCall(usage?: ExecutorModelCall): void;
  /**
   * Records one executor tool call that did not go through `actions` — a
   * project tool from `defineTool`. A mutating tool consumes an action-budget
   * slot and may throw `STEP_BUDGET_EXHAUSTED`; every call is recorded as a
   * step event, so extensions run the same accounting pipeline as the
   * grammar.
   */
  recordToolCall(call: { name: string; mutates: boolean; durationMs?: number }): void;
}

/**
 * Why a cached replay stopped before finishing its trace. A closed union: the
 * executor sees a reason token and prose summaries, never descriptors,
 * outputs, or error objects.
 */
export type ReplayHandOffReason =
  | 'gap'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'action-failed'
  | 'action-uncertain'
  | 'end-mismatch';

/**
 * The mid-step hand-off from a diverged cache replay (RFC0001 layer 4). The
 * replayed actions already ran against the live app under the same budgets
 * and recording as the executor's own; the executor continues the step from
 * the current application state and must not redo them.
 */
export interface ReplayedPrefix {
  /** Prose summaries of the actions replay performed, in order. */
  readonly replayedActions: readonly string[];
  readonly totalActions: number;
  readonly stopReason: ReplayHandOffReason;
  /**
   * Present exactly when `stopReason` is `action-uncertain`: the summary of a
   * replayed action whose input may have reached the app even though it
   * failed (spec 09, ACTION_MAY_HAVE_COMMITTED). The executor must verify the
   * current state before re-attempting anything like it — repeating it blind
   * would double-commit a mutation the runner promised not to repeat.
   */
  readonly uncertainAction?: string;
}

export interface StepExecutorContext {
  readonly step: ExecutorStep;
  /** The target this step runs on; tool packs scope themselves by its platform. */
  readonly target: { readonly name: string; readonly platform: Platform };
  /**
   * Present when a cached replay ran part of this step before handing it
   * over. Absent on a cache miss or when caching is off.
   */
  readonly replayedPrefix?: ReplayedPrefix;
  /**
   * Aborts when the test is cancelled, when the step deadline expires, or on
   * any other hard stop. An executor must stop promptly on abort; the harness
   * settles the step at the hard stop either way, so a late verdict from an
   * executor that ignored the signal is never trusted over it.
   */
  readonly signal: AbortSignal;
  /**
   * The config-resolved AI SDK language model, when one is configured. An
   * executor may ignore it and bring its own; a hand-rolled executor may use
   * no model at all.
   */
  readonly model: ModelInstance | undefined;
  /** Completed prior steps serialized for prompt context; `''` when none. */
  readonly ledger: string;
  /** Trusted project/test agent context (config `agent.context` + test). */
  readonly agentContext: string | undefined;
  readonly budgets: ExecutorBudgets;
  /** Captures one fresh, redacted observation. */
  observe(): Promise<ExecutorObservation>;
  readonly actions: ExecutorActions;
  /**
   * Attaches the executor's model transcript to the step. Persisted as a
   * `log` artifact when the run collects debug detail (`--debug`); a no-op
   * otherwise. Call once, at conclusion.
   */
  attachTranscript(text: string): void;
}

export type StepVerdictStatus = 'passed' | 'failed' | 'blocked';

/**
 * The ternary step verdict. `failed` means the application did not behave as
 * the step required. `blocked` means the environment, credentials, or the
 * executor's own budget prevented a product verdict — it says nothing about
 * the product, and it always carries a blockable error code.
 */
export interface StepVerdict {
  readonly status: StepVerdictStatus;
  readonly summary: string;
  readonly errorCode?: AgentErrorCode;
}

/** The brain socket: one step in, one verdict out. */
export interface StepExecutor {
  readonly name: string;
  readonly version?: string;
  runStep(context: StepExecutorContext): Promise<StepVerdict>;
}

/**
 * Codes only the runtime may assign. An executor can carry them (they reach
 * it through hard-stop errors raised by the context) but can never invent
 * them: the harness rejects a runtime code it did not itself record.
 */
export const RUNTIME_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'STEP_BUDGET_EXHAUSTED',
  'STEP_TIMEOUT',
  'CANCELLED',
]);

/**
 * Codes a `blocked` verdict may carry — every code the table assigns a
 * blocked category: credentials, environment, seed data, or test setup have
 * external owners; `automation` means the executor ran out of room.
 * Everything else describes product behavior and belongs to `failed`.
 */
export const BLOCKABLE_CODES: ReadonlySet<AgentErrorCode> = new Set(
  (Object.keys(AGENT_CODE_TABLE) as AgentErrorCode[]).filter(
    (code) => AGENT_CODE_TABLE[code].blockedCategory !== undefined,
  ),
);

/** Structural executor check, mirroring how model instances are detected. */
export function isStepExecutor(value: unknown): value is StepExecutor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    candidate['name'] !== '' &&
    typeof candidate['runStep'] === 'function'
  );
}
