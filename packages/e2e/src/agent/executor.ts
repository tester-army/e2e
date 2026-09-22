/**
 * The step-executor socket.
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

import type { ObservationPixels, SemanticNode, ViewportPoint, ViewportSize } from '../engine/surface.ts';
import type { VisionDegradation, StepTurn } from '../run/steps.ts';
import type {
  AgentErrorCode,
  JsonValue,
  ModelInstance,
  ProviderOptions,
  ScrollDirection,
  Secret,
} from '../types.ts';
import { AGENT_CODE_TABLE, isAgentError, type AgentError } from './error.ts';

/**
 * One step handed to an executor. `act` plans and executes a flow; `assert`
 * judges a condition and must not change application state.
 */
export interface ExecutorStep {
  readonly kind: 'act' | 'assert';
  /** Zero-based position of this step in the attempt's step timeline. */
  readonly index: number;
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

/**
 * The attempt a step belongs to: identity and lifecycle. This is what lets an
 * executor keep state across the `agent.act()` calls of one test — a running
 * conversation, a plan, notes — without confusing it with the next test's or
 * a retry's. Serial-group members share one attempt scope, as they share the
 * ledger.
 */
export interface ExecutorAttempt {
  readonly testId: string;
  readonly attemptId: string;
  /** Zero-based retry index of this attempt. */
  readonly index: number;
  /**
   * Aborts when the attempt ends — passed, failed, or cancelled. An executor
   * holding per-attempt state releases it on this signal.
   */
  readonly signal: AbortSignal;
  /**
   * Executor scratch space for the attempt. Held by the harness for the
   * attempt's lifetime and never persisted, reported, or shown to a model by
   * the harness: what goes in is the executor's, redaction included. Keyed
   * so several executors (or an executor and its tools) can share it.
   */
  readonly memory: Map<string, unknown>;
}

/** What an executor asks `observe()` to include beyond the text serialization. */
export interface ExecutorObserveOptions {
  /** Include the redacted node tree as `tree`. */
  readonly tree?: boolean;
  /**
   * Include masked viewport pixels as `pixels`. Granted only when the engine
   * captures pixels, its masking is proven, and no secret has been filled in
   * this attempt; otherwise `pixelsWithheld` names the reason. Normally off
   * unless asked. If semantic capture fails, the observation carries its
   * permitted screenshot because no semantic evidence is available.
   */
  readonly pixels?: boolean;
}

/**
 * One node of the redacted semantic tree. Names, text, values, and attribute
 * values are secret-redacted; a secure node carries no value at all.
 */
export interface ExecutorNode {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly inputPurpose?: SemanticNode['inputPurpose'];
  readonly states?: SemanticNode['states'];
  readonly attributes?: Readonly<Record<string, string>>;
  readonly rect?: SemanticNode['rect'];
  readonly framePath?: readonly string[];
  readonly children?: readonly ExecutorNode[];
}

/** Masked viewport pixels cleared for model input: the engine's capture plus its proven mask count. */
export interface ExecutorPixels extends ObservationPixels {
  readonly maskedRegionCount: number;
}

/** Redacted, size-bounded observation an executor may show its model. */
export interface ExecutorObservation {
  /** Semantic capture failed; use the accompanying pixels, never this listing as absence evidence. */
  readonly treeUnavailable?: true;
  readonly revision: string;
  /** One node per line as `#id role "name" ...`; already secret-redacted. */
  readonly text: string;
  readonly truncated: boolean;
  readonly viewport: ViewportSize;
  /**
   * The current location as path and query, redacted, when the engine
   * reports one. Absent on engines without a location (a device screen).
   */
  readonly path?: string;
  /** The redacted node tree; present when requested with `observe({ tree: true })`. */
  readonly tree?: ExecutorNode;
  /** Masked pixels; present when requested with `observe({ pixels: true })` and granted. */
  readonly pixels?: ExecutorPixels;
  /** Why requested pixels were withheld; the same token the report's `visionDegraded` carries. */
  readonly pixelsWithheld?: VisionDegradation;
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
 * form fill — is legitimate), the engine rejects references it can no longer
 * bind (`NODE_STALE`), and the mutation's effects are visible only through a
 * fresh `observe()`.
 */
export interface ExecutorActions {
  tap(target: ExecutorTarget): Promise<void>;
  type(target: ExecutorTarget, value: string): Promise<void>;
  /**
   * Fills one secret declared in the step's params into an input. The
   * harness authorizes the fill (configured secret, origin policy, an
   * editable sink; a password field for a password) and hands the plaintext straight to
   * the engine — it never passes through the executor or any model.
   */
  typeSecret(target: ExecutorTarget, name: string): Promise<void>;
  press(target: ExecutorTarget, key: string): Promise<void>;
  select(target: ExecutorTarget, value: string): Promise<void>;
  /**
   * Scrolls the viewport, or one node by a swipe inside its box. A scroll
   * target is what sits where it sits more than what it says: a device
   * names a scroll view after its first visible row and renumbers the tree
   * on every look, so a target id the newest screen lacks is re-found by its
   * place and role, and a list that filled the screen and cannot be re-found
   * scrolls as the viewport, which is what scrolling the main list does.
   */
  scroll(direction: ScrollDirection, target?: ExecutorTarget): Promise<void>;
  /** Navigates to an http(s) URL or an app-relative path. */
  navigate(url: string): Promise<void>;
  /**
   * Taps one viewport point, in the CSS pixels of the newest observation
   * (`SemanticNode.rect` space; a point read off `pixels` is divided by its
   * `scale`). The point is routed onto the tree: a listed, enabled control
   * whose box contains it is tapped by its id, exactly like `tap`, with a
   * replayable descriptor; a point on nothing listed goes to the engine as a
   * bare point when it has the `pointer` capability, recorded as a trace gap.
   * Fails when the point is on nothing listed and the engine taps nodes only.
   */
  tapAt(point: ViewportPoint): Promise<PointTapResult>;
  /**
   * Types into whatever holds focus, with no node resolved: the path for a
   * field the tree does not list (drawn on a canvas, flattened out of a
   * platform's accessibility tree) after a `tapAt` gave it focus. Inserts at
   * the caret; `replace` clears the field first. Fails with `ACTION_FAILED`
   * when nothing that accepts text has focus, never typing into the void.
   * Needs the engine's `keyboard` capability (`typeText` in `target.verbs`).
   */
  typeText(value: string, options?: { readonly replace?: boolean }): Promise<void>;
  /** Sends one key to whatever holds focus (`pressKey` in `target.verbs`). */
  pressKey(key: string): Promise<void>;
  /** Hides an on-screen keyboard (`dismissKeyboard` in `target.verbs`). */
  dismissKeyboard(): Promise<void>;
  /**
   * What the newest observation lists at one viewport point, in the same CSS
   * pixels `tapAt` takes: the innermost enabled control whose box contains
   * the point, and the innermost listed node of any role. What a
   * point-addressed verb resolves its target through before calling `type`,
   * `press`, `select`, or `scroll` by id, so the action is policed, recorded,
   * and replayed exactly like one the model addressed by id. Resolved in
   * queue order, like every target.
   */
  hitTest(point: ViewportPoint): Promise<PointHit>;
}

/** What one `hitTest` found, for the executor to act on or relay. */
export interface PointHit {
  /** Where the point landed after clamping to the viewport, in CSS pixels. */
  readonly point: ViewportPoint;
  /** The innermost enabled control containing the point, if any is listed. */
  readonly control?: ExecutorTarget;
  /** The innermost listed node of any role containing the point, if any. */
  readonly under?: ExecutorTarget;
  /** Prose for a model: the control's own line, or that nothing listed is there. */
  readonly summary: string;
}

/** What one `tapAt` did, for the executor to relay to its model. */
export interface PointTapResult {
  /** Where the tap landed, in the newest observation's CSS pixels. */
  readonly point: ViewportPoint;
  /** The listed control the point resolved to; absent when a bare point was tapped. */
  readonly target?: ExecutorTarget;
  /** Prose for a model: what was tapped, or what sits under a bare point. */
  readonly summary: string;
}

/** Usage detail of one executor-made model call, all fields optional. */
export interface ExecutorModelCall {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Input tokens served from the provider's prompt cache, when it reports the split. */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache, when it reports the split. */
  readonly cacheWriteTokens?: number;
  /**
   * ISO 8601 instant the request went out. The `model` step event takes it
   * as `startedAt`, so a tool-using loop that reports a turn after its tools
   * ran still lands the turn ahead of them in time order. Omitted, the
   * harness stamps the moment of the report.
   */
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly provider?: string;
  readonly modelId?: string;
  /** Billed cost of this call in USD, when the provider reports one. */
  readonly estimatedCostUsd?: number;
  /**
   * The model's own reasoning for the turn, when it produced one. Reported so
   * the step's `model` event can show why the model acted; the harness
   * redacts and bounds the excerpt, and the AI trace keeps the full text.
   */
  readonly reasoning?: string;
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
   * Runs one project tool (a `defineTool` value) under the step's accounting:
   * a mutating tool reserves an action-budget slot before its body runs and
   * may throw `STEP_BUDGET_EXHAUSTED`; mutations are serialized with grammar
   * actions; every call is recorded as a step event.
   */
  runTool<T>(call: { name: string; mutates: boolean }, body: () => Promise<T>): Promise<T>;
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
  /** A recorded bare-point tap met a viewport of another size; the point would land elsewhere. */
  | 'viewport-changed'
  | 'action-failed'
  | 'action-uncertain'
  | 'end-mismatch';

/**
 * The mid-step hand-off from a diverged cache replay. The
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

/** One verb of the action grammar. */
export type ExecutorVerb = keyof ExecutorActions;

export interface StepExecutorContext {
  readonly step: ExecutorStep;
  /** The attempt this step runs in: identity, end-of-attempt signal, and scratch memory. */
  readonly attempt: ExecutorAttempt;
  /**
   * The target this step runs on. Tool packs scope themselves by its platform;
   * `verbs` is the subset of the action grammar the engine declared, so an
   * executor offers a model exactly the vocabulary the surface can honor.
   */
  readonly target: {
    readonly name: string;
    readonly platform: string;
    readonly verbs: ReadonlySet<ExecutorVerb>;
  };
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
  /**
   * The config-resolved `agent.providerOptions`, when set. The built-in
   * executor sends them with every model call unless it was given its own.
   */
  readonly providerOptions: ProviderOptions | undefined;
  /**
   * Completed prior steps of this attempt (and, in a serial group, of earlier
   * members) serialized for prompt context, oldest first, bounded by
   * `limits.maxLedgerBytes`; `''` when none.
   */
  readonly ledger: string;
  /** Trusted project/test agent context (config `agent.context` + test). */
  readonly agentContext: string | undefined;
  readonly budgets: ExecutorBudgets;
  /**
   * Captures one fresh, redacted observation. The text serialization is always
   * present; the tree and pixels are opt-in, so an executor that renders its
   * own view of the screen asks for exactly the material it uses.
   */
  observe(options?: ExecutorObserveOptions): Promise<ExecutorObservation>;
  readonly actions: ExecutorActions;
  /**
   * True once a secret was filled in this attempt: `observe({ pixels: true })`
   * withholds pixels for the rest of it. An executor reads it when assembling
   * its vocabulary, to leave screenshot verbs out rather than offer tools
   * that can only decline.
   */
  readonly pixelsTainted: boolean;
  /**
   * Attaches the executor's model transcript to the step. Persisted as a
   * `log` artifact when the run collects debug detail (`--debug`); a no-op
   * otherwise. Call once, at conclusion.
   */
  attachTranscript(text: string): void;
  /**
   * Keeps a bounded record of the step's model turns on the step record,
   * whatever the run's debug setting: each turn's tool calls and what came
   * back, clipped. The report shows the last turns under a failed step, so
   * a reader sees what the model did and saw without the transcript.
   */
  attachTurns(turns: readonly StepTurn[]): void;
  /**
   * Keeps pixels the executor or one of its tools observed as a `screenshot`
   * artifact of the step in progress, and resolves with the artifact's report
   * id: what a tool with evidence worth keeping (a defect on screen) calls.
   * The file lands in the attempt's artifact directory and the report's
   * artifact records like every screenshot the runner takes, and reaches a
   * configured `ArtifactStore`. The label names the file.
   */
  attachScreenshot(pixels: ExecutorPixels, label: string): Promise<string>;
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
  /**
   * Trace-cache participation for this executor's steps. `inherit` (the
   * default) follows the configured cache mode; `off` never replays a cached
   * trace for the executor's steps and records none, so every step reaches
   * `runStep` — for a brain whose own history or memory is the source of
   * truth, or one that must see every step run.
   */
  readonly cache?: 'inherit' | 'off';
  /**
   * The model this executor brought along, when it has one. Config resolution
   * reads it as the run's model when `agent.model` is unset, so one
   * `createAgent({ model })` drives both `act` and the judgment tier;
   * `INVALID_CONFIG` when both are set and differ.
   */
  readonly model?: ModelInstance;
  /**
   * The model the judgment tier (`assert`, `waitFor`, `extract`) calls for
   * this executor's agent, when it differs from `model`. Config resolution
   * reads it as the agent's judge when `agent.judge` is unset;
   * `INVALID_CONFIG` when both are set and differ.
   */
  readonly judge?: ModelInstance;
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
 * Whether an error is one of the runtime's own hard stops. Such an error is
 * the step's truth wherever it lands — inside a tool call, a cache probe, a
 * replayed action — and is surfaced untouched rather than absorbed as a
 * divergence, a miss, or an action failure.
 */
export function isRuntimeHardStop(cause: unknown): cause is AgentError {
  return isAgentError(cause) && RUNTIME_CODES.has(cause.code);
}

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
