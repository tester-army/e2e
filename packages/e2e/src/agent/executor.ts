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
  scroll(direction: ScrollDirection, target?: ExecutorTarget): Promise<void>;
  /** Navigates within the configured allowed origins. */
  navigate(url: string): Promise<void>;
}

/** Step budgets, read and reported by the executor, enforced by the harness. */
export interface ExecutorBudgets {
  readonly maxActions: number;
  readonly maxModelCalls: number;
  actionsUsed(): number;
  remainingMs(): number;
  /** Records one executor-made model call in the step metrics. */
  recordModelCall(usage?: { inputTokens?: number; outputTokens?: number }): void;
}

export interface StepExecutorContext {
  readonly step: ExecutorStep;
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
