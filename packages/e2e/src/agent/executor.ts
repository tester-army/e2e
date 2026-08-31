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

import type { AgentErrorCode, JsonValue, ModelInstance, ScrollDirection } from '../types.ts';

/** One step handed to an executor: one `agent.act()` call. */
export interface ExecutorStep {
  readonly kind: 'act';
  /** The natural-language instruction the test passed. */
  readonly instruction: string;
  /** JSON-safe call parameters; secrets are rejected before dispatch in v0. */
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
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
 * id fails the action rather than acting on the wrong node.
 */
export interface ExecutorActions {
  tap(target: ExecutorTarget): Promise<void>;
  type(target: ExecutorTarget, value: string): Promise<void>;
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

export interface StepExecutorContext {
  readonly step: ExecutorStep;
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
 * Codes a `blocked` verdict may carry. Budget and timeout codes mean the
 * executor ran out of room ("automation" blocks); the rest name environment
 * or setup problems. Everything else describes product behavior and belongs
 * to `failed`.
 */
export const BLOCKABLE_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'APP_UNREACHABLE',
  'APP_NOT_OPEN',
  'POLICY_DENIED',
  'MODEL_UNAVAILABLE',
  'STEP_BUDGET_EXHAUSTED',
  'STEP_TIMEOUT',
]);

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
