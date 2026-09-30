/** Attempt-scoped step timeline. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAgentError } from '../agent/error.ts';
import type { ReplayHandOffReason } from '../agent/executor.ts';
import type { TraceReplayMissReason } from '../cache/decide.ts';
import type { DerivedReason } from '../cache/trace.ts';
import { withAiTraceStep } from '../internal/ai-trace.ts';
import { classifyError, serializeError, TestError, withHint, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { sourceLocation, type SourceLocation } from '../internal/source.ts';

/** The closed step kind set; the type is derived from it, so the two cannot drift. */
export const STEP_KINDS = ['agent', 'locator', 'assertion', 'screen', 'app', 'session', 'resource'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Child event of one public step: polls, model calls, policy decisions.
 * `tool-proposal` (report-1) belongs to the planning tier and is not emitted
 * by this milestone.
 */
export interface StepEvent {
  kind: 'poll' | 'observation' | 'model' | 'policy' | 'engine' | 'schema';
  /**
   * When the event began, not when it was recorded. A `model` event carries
   * the moment the request went out even when the executor reports the turn
   * after the tool calls it made, so events sorted by `startedAt` are in
   * causal order while `events` itself is in recording order.
   */
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  name?: string;
  count?: number;
  /**
   * Prompt and completion tokens of one model call, when the provider
   * reported both; `count` is their sum. Lets a live reporter show the split.
   */
  inputTokens?: number;
  outputTokens?: number;
  bytes?: number;
  decision?: 'allowed' | 'denied';
  code?: string;
  /**
   * Redacted human prose for what the event did — `tap button "Approve"`,
   * `fill secret "password" into textbox "Password"`. Driver action events
   * carry one so a live reporter can render the act without a side lookup;
   * secret values never appear (the name stands in), and the text is bounded.
   */
  detail?: string;
  /**
   * Bounded, redacted excerpt of the reasoning a model turn produced, when
   * the provider returns one. Lets a live reporter show why the model acted,
   * not just that it did. Secrets never reach model input, and the attempt
   * redactor runs over the excerpt regardless; the full text lives in the AI
   * trace, never here.
   */
  reasoning?: string;
}

/** Required accounting for every agent step. */
export interface StepMetrics {
  modelCalls: number;
  actionSteps: number;
  observationBytes: number;
  contextBytes: number;
  ledgerBytes: number;
  /** Largest masked image sent to the model in this step, in bytes. */
  pixelBytes?: number;
}

/**
 * Why a vision step fell back to tree-only input. Pixel evidence degrades
 * rather than failing the step.
 */
export type VisionDegradation = 'PIXEL_TAINTED' | 'MASKING_UNPROVEN' | 'UNSUPPORTED_CAPABILITY';

/** Model provenance and usage for one model-backed step. */
export interface StepModelInfo {
  provider: string;
  model: string;
  endpoint: string;
  adapterVersion: string;
  policyVersion: string;
  calls: number;
  tokenAccounting: 'provider' | 'adapter-upper-bound';
  peakTokensPerCall: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens the provider served from its prompt cache and wrote to it,
   * summed over the step's calls; present only when the provider reports the
   * split. Cached reads are part of `inputTokens`, not in addition to it.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * How the trace cache participated in one agent step. `self-finalized` means
 * the full trace replayed and the step passed with zero model calls;
 * `agent-concluded` means a replayed prefix handed the step to the executor;
 * `missed` means the executor ran the step from the top.
 */
export interface StepCacheInfo {
  mode: 'self-finalized' | 'agent-concluded' | 'missed';
  /** The miss or hand-off reason token; absent on `self-finalized`. */
  reason?: TraceReplayMissReason | ReplayHandOffReason;
  /**
   * On a `gap` at a typed value: the rule that made the value this run's
   * data rather than the flow's. Absent for a gap at a project tool.
   */
  derived?: DerivedReason;
  /**
   * Why a passing step that ran live was still not recorded, when the cause
   * is the call itself: `param-collision` when a `unique()` value equals, is
   * spelled inside, or is the encoded form of another param's value, so the
   * recording could not tell which param a recorded input came from.
   */
  notRecorded?: 'param-collision';
  /** On an `end-mismatch` hand-off: the recorded end anchors the screen did not show, as prose. */
  missingAnchors?: string[];
  replayedActions: number;
  totalActions: number;
}

/** Agent-specific step detail attached while the step is still running. */
export interface StepAgentDetails {
  metrics?: StepMetrics;
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  /** Absent when the step failed before capturing an observation. */
  observationRevision?: string;
  /** Absent when capture failed before a judgment could be requested. */
  explanation?: string;
  /** True when masked pixel evidence was model input, not just an artifact. */
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  /**
   * True when `vision: 'only'` withheld the semantic tree, leaving the masked
   * screenshot as the model's only evidence. `metrics.observationBytes` is then
   * zero, because the observation contributed nothing to the request.
   */
  visionOnly?: boolean;
  /** The step's last model turns, bounded; see `StepTurn`. */
  turns?: StepTurn[];
}

/**
 * One model turn of an agent step, as the report keeps it: the tool calls
 * the model made and what came back, each bounded. Enough to read why the
 * step ended where it did without the full transcript.
 */
export interface StepTurn {
  /** One-based turn number within the step. */
  index: number;
  /** `tap({"target":"n19"})`, one per tool call, arguments clipped. */
  calls: string[];
  /** The tool results of the turn, clipped; a screen diff reads as its first lines. */
  outcome: string;
}

export interface StepRecord {
  id: string;
  index: number;
  kind: StepKind;
  api: string;
  label: string;
  /** The test line the step was called from; absent when no project line was on the stack. */
  source?: SourceLocation;
  status: 'passed' | 'failed' | 'blocked' | 'timed-out' | 'cancelled';
  startedAt: string;
  durationMs: number;
  observationRevision?: string;
  explanation?: string;
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  visionOnly?: boolean;
  viewport?: { width: number; height: number; scale: number };
  metrics?: StepMetrics;
  cache?: StepCacheInfo;
  events: StepEvent[];
  /** The model turns of an agent step, most recent last, bounded. */
  turns?: StepTurn[];
  model?: StepModelInfo;
  /** The configured agent an agent step ran with, by name. */
  agent?: string;
  error?: SerializedError;
  artifacts: string[];
}

/**
 * Live progress notification for one step, streamed to reporters as the step
 * runs. Derived from the same records the report persists; the report stays
 * the canonical record.
 */
/** The work a running agent step can be waiting on; see `StepProgress`. */
export type StepActivity = 'observe' | 'model' | 'action';

/** IDs join live progress to the report. Step indexes are local to each test or serial member. */
interface StepProgressIdentity {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly stepId: string;
  readonly stepIndex: number;
}

/** One progress payload before the recorder attaches its identity. */
type StepProgressFact =
  | { readonly phase: 'start'; readonly kind: StepKind; readonly api: string; readonly label: string }
  | {
      readonly phase: 'end';
      readonly kind: StepKind;
      readonly api: string;
      readonly label: string;
      readonly status: StepRecord['status'];
      readonly durationMs: number;
      readonly modelCalls: number;
      /** The same redacted error the finished step records. */
      readonly error?: SerializedError;
      readonly explanation?: string;
    }
  | { readonly phase: 'event'; readonly api: string; readonly event: StepEvent }
  /**
   * What the running step is waiting on right now: a device or browser being
   * read (`observe`), an action landing (`action`), or a model turn
   * (`model`). Emitted as each begins; the matching `event` reports its end.
   * On a device a snapshot or a tap takes seconds, so between events the
   * model is not always the one working.
   */
  | { readonly phase: 'activity'; readonly api: string; readonly activity: StepActivity }
  /**
   * The trace cache took the step (`active`), or handed it to the model after
   * a replay that could not finish it; a step the replay finishes ends while
   * the cache has it. While the cache has the step, recorded actions execute
   * with no model in the loop, so the wait between events is on the app
   * settling, not on a model turn.
   */
  | { readonly phase: 'replay'; readonly api: string; readonly active: boolean };

/** Every runner-produced phase carries identity; optional for consumers of older event streams. */
export type StepProgress = StepProgressFact & { readonly identity?: StepProgressIdentity };

/** Per-step options for `StepRecorder.run`. */
export interface StepRunOptions {
  /**
   * Whether the step checks state rather than producing it: a deterministic
   * assertion, a locator wait, or an agent judgment. Only such a step passing
   * can confirm a staged action trace (cache/context.ts) — an `agent.act`
   * passing is the executor's opinion of its own work, and an `app` or
   * `locator` action passing proves only that the action could be performed.
   * Declared where the step is minted, so the rule cannot drift from the api
   * names.
   */
  readonly verifies?: boolean;
  /** The configured agent an agent step runs with, recorded on the step. */
  readonly agent?: string | undefined;
}

export interface StepRecorderOptions {
  /** The report-owning attempt; serial members share their group's attempt identity. */
  readonly attempt?: { readonly id: string; readonly index: number };
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
  /** Live progress sink; omitted in contexts with no reporter to feed. */
  readonly onProgress?: (progress: StepProgress) => void;
  /** The project root; with it, every step and step error names the test line it came from. */
  readonly projectRoot?: string;
  /** Replaces secret values in a step error's message and details before the record keeps them. */
  readonly redact?: (text: string) => string;
}

/** Frames kept when a step captures where it was called from; the user's line is a few frames up. */
const STEP_STACK_FRAMES = 20;

/** What abandoned steps rejected with. The promise the test holds rejects with the same value, and nobody awaits it. */
const ABANDONED_REJECTIONS = new WeakSet<object>();

/**
 * Whether an unhandled rejection is an abandoned step's: already recorded as
 * `STEP_NOT_AWAITED`, reaching the process only because the promise the
 * test did not await rejected with it. Such a rejection is not a fault.
 */
export function isAbandonedStepRejection(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && ABANDONED_REJECTIONS.has(cause);
}

/**
 * The stack at a step's start, or nothing without a project root to read it
 * against. Every step pays the capture, since the failing one is not known
 * until it fails, and a report that names the line is worth it. The stack
 * outlives the source it yields: a step the body abandoned reports its
 * failure from the line it was called on.
 */
function stepStack(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined) return undefined;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STEP_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Points `error` at the frames of `stack`, keeping its own name and message as the first line. */
function relocate(error: Error, stack: string | undefined): void {
  if (stack === undefined) return;
  const frames = stack.split('\n').slice(1).join('\n');
  error.stack = `${error.name}: ${error.message}\n${frames}`;
}

/** Characters of a step label an error message quotes before clipping it. */
const MAX_QUOTED_LABEL_CHARS = 80;

function quoted(label: string): string {
  return `"${label.length > MAX_QUOTED_LABEL_CHARS ? `${label.slice(0, MAX_QUOTED_LABEL_CHARS - 3)}...` : label}"`;
}

export class StepRecorder {
  private readonly attempt: { readonly id: string; readonly index: number };
  private readonly steps: StepRecord[] = [];
  private readonly scope = new AsyncLocalStorage<StepRecord>();
  /** IDs of steps whose bodies are still executing. */
  private readonly running = new Set<string>();
  /** The promise each running step returned to its caller, to observe when the caller did not. */
  private readonly pending = new Map<string, Promise<unknown>>();
  /** The stack each running step was started from, for the error a step abandoned by the body carries. */
  private readonly stacks = new Map<string, string>();
  /** Steps the body returned without awaiting: recorded as failed already, whatever they do next. */
  private readonly abandoned = new Set<string>();
  /** The promises of abandoned steps, for the wait before teardown. */
  private readonly abandonedPromises: Promise<unknown>[] = [];
  /** Highest timeline index among passed verification steps, or -1 when none has. */
  private lastVerified = -1;
  private readonly maxEventsPerStep: number;
  private readonly onProgress: ((progress: StepProgress) => void) | undefined;
  private readonly projectRoot: string | undefined;
  private readonly redact: ((text: string) => string) | undefined;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.attempt = options.attempt ?? { id: attemptId, index: 0 };
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
    this.onProgress = options.onProgress;
    this.projectRoot = options.projectRoot;
    this.redact = options.redact;
  }

  /** The step currently executing, when inside StepRecorder.run. */
  get currentStepId(): string | undefined {
    return this.current()?.id;
  }

  /** Timeline index of the currently executing step. */
  get currentStepIndex(): number | undefined {
    return this.current()?.index;
  }

  /** Highest timeline index among passed verification steps, or -1 when none has. */
  get lastVerifiedStepIndex(): number {
    return this.lastVerified;
  }

  /** Runs one public API call as a recorded top-level step. */
  run<T>(
    kind: StepKind,
    api: string,
    label: string,
    body: () => Promise<T>,
    options: StepRunOptions = {},
  ): Promise<T> {
    const index = this.steps.length;
    const startedAt = timestamp();
    const stack = stepStack(this.projectRoot);
    const source = sourceLocation(stack, this.projectRoot);
    const record: StepRecord = {
      id: `${this.attemptId}:${index}`,
      index,
      kind,
      api,
      label,
      ...(source === undefined ? {} : { source }),
      status: 'passed',
      startedAt,
      durationMs: 0,
      events: [],
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      artifacts: [],
    };
    this.steps.push(record);
    this.running.add(record.id);
    if (stack !== undefined) this.stacks.set(record.id, stack);
    this.publish(record, { phase: 'start', kind, api, label });
    const promise = this.execute(record, body, options);
    this.pending.set(record.id, promise);
    return promise;
  }

  private async execute<T>(record: StepRecord, body: () => Promise<T>, options: StepRunOptions): Promise<T> {
    const startedMs = Date.now();
    try {
      // Model calls made inside the body are attributed to this step.
      const result = await this.scope.run(record, () => withAiTraceStep(record.api, record.label, body));
      if (this.abandoned.has(record.id)) return result;
      record.durationMs = Date.now() - startedMs;
      if (options.verifies === true) this.lastVerified = Math.max(this.lastVerified, record.index);
      return result;
    } catch (cause) {
      if (this.abandoned.has(record.id)) {
        if (typeof cause === 'object' && cause !== null) ABANDONED_REJECTIONS.add(cause);
        throw cause;
      }
      record.durationMs = Date.now() - startedMs;
      const error = classifyError(cause);
      // A blocked verdict is a distinct outcome, not a product failure: the
      // step's error names what stood in the way, and the report says so.
      record.status =
        error.code === 'CANCELLED'
          ? 'cancelled'
          : isAgentError(cause) && cause.blocked
            ? 'blocked'
            : 'failed';
      record.error = serializeError(error, { projectRoot: this.projectRoot, redact: this.redact });
      throw cause;
    } finally {
      this.running.delete(record.id);
      this.pending.delete(record.id);
      this.stacks.delete(record.id);
      // An abandoned step reported its end when the body returned; what it did since is not the test's.
      if (!this.abandoned.delete(record.id)) this.publishEnd(record);
    }
  }

  /**
   * Fails every step still running once the test body has settled, and
   * returns the error that names them, or nothing when every step was
   * awaited. Each such step is recorded as failed at the line it was called
   * on, its later outcome is dropped, and its rejection is observed here: a
   * step the body abandoned must not take the worker down as an unhandled
   * rejection.
   */
  abandonRunning(): TestError | undefined {
    const running = this.steps.filter((step) => this.running.has(step.id) && !this.abandoned.has(step.id));
    let first: TestError | undefined;
    for (const step of running) {
      const more = first === undefined && running.length > 1 ? ` and ${running.length - 1} more` : '';
      const error = new TestError(
        'STEP_NOT_AWAITED',
        withHint(`the test body returned before ${step.api} ${quoted(step.label)}${more} finished`, 'put `await` in front of every step call'),
      );
      relocate(error, this.stacks.get(step.id));
      first ??= error;
      this.abandoned.add(step.id);
      step.status = 'failed';
      step.durationMs = Math.max(0, Date.now() - Date.parse(step.startedAt));
      step.error = serializeError(error, { projectRoot: this.projectRoot, redact: this.redact });
      const promise = this.pending.get(step.id);
      if (promise !== undefined) {
        promise.catch(() => undefined);
        this.abandonedPromises.push(promise);
      }
      this.publishEnd(step);
    }
    return first;
  }

  /** Resolves once every abandoned step has settled, however it did; the caller bounds the wait. */
  async settleAbandoned(): Promise<void> {
    await Promise.allSettled(this.abandonedPromises);
  }

  private publishEnd(record: StepRecord): void {
    this.publish(record, {
      phase: 'end',
      kind: record.kind,
      api: record.api,
      label: record.label,
      status: record.status,
      durationMs: record.durationMs,
      modelCalls: record.events.filter((event) => event.kind === 'model').length,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.explanation === undefined ? {} : { explanation: record.explanation }),
    });
  }

  /**
   * Attaches an artifact ID to the running step, or to the most recent step
   * when none is running. The running step wins so a step that ran a nested
   * step (a fixture call that clicked a link, say) still owns what it produced.
   */
  attachArtifact(artifactId: string): void {
    // Cleanup outside a scope may attach to the last step. Work inherited
    // from a closed scope must never attach to a newer step.
    const target = this.scope.getStore() === undefined
      ? this.steps[this.steps.length - 1]
      : this.current();
    if (target !== undefined) target.artifacts.push(artifactId);
  }

  /** Records one child event of the running step. */
  recordEvent(event: StepEvent): void {
    const current = this.current();
    if (current === undefined) return;
    if (current.events.length >= this.maxEventsPerStep) return;
    current.events.push(event);
    this.publish(current, { phase: 'event', api: current.api, event });
  }

  /**
   * Tells reporters the trace cache has the running step (`true`), or has
   * handed it to the model (`false`). Nothing is recorded: the step's `cache`
   * detail says how the replay went. Outside a running step this is a no-op,
   * as `recordEvent` is.
   */
  replaying(active: boolean): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'replay', api: current.api, active });
  }

  /**
   * Tells reporters what the running step waits on now; the phase's `event`
   * later reports how it went. Nothing is recorded. Outside a running step
   * this is a no-op, as `recordEvent` is.
   */
  activity(activity: StepActivity): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'activity', api: current.api, activity });
  }

  /** Merges agent metrics, provenance, and judgment detail into the running step. */
  attachAgentDetails(details: StepAgentDetails): void {
    const current = this.current();
    if (current === undefined) return;
    if (details.metrics !== undefined) current.metrics = details.metrics;
    if (details.model !== undefined) current.model = details.model;
    if (details.cache !== undefined) current.cache = details.cache;
    if (details.observationRevision !== undefined) {
      current.observationRevision = details.observationRevision;
    }
    if (details.explanation !== undefined) {
      current.explanation = this.redact?.(details.explanation) ?? details.explanation;
    }
    if (details.visionInput !== undefined) current.visionInput = details.visionInput;
    if (details.visionDegraded !== undefined) current.visionDegraded = details.visionDegraded;
    if (details.visionOnly !== undefined) current.visionOnly = details.visionOnly;
    if (details.turns !== undefined) current.turns = details.turns;
  }

  /** Records the viewport a step established. */
  attachViewport(viewport: { width: number; height: number; scale: number }): void {
    const current = this.current();
    if (current !== undefined) current.viewport = viewport;
  }

  all(): readonly StepRecord[] {
    return this.steps;
  }

  /** Steps whose execution has finished, e.g. as prior-step prompt context. */
  completed(): readonly StepRecord[] {
    return this.steps.filter((step) => !this.running.has(step.id));
  }

  private current(): StepRecord | undefined {
    const record = this.scope.getStore();
    return record !== undefined && this.running.has(record.id) && !this.abandoned.has(record.id) ? record : undefined;
  }

  /** Publishes a phase with the owning record's identity, including nested and finishing steps. */
  private publish(record: StepRecord, progress: StepProgressFact): void {
    this.onProgress?.({
      ...progress,
      identity: {
        attemptId: this.attempt.id,
        attemptIndex: this.attempt.index,
        stepId: record.id,
        stepIndex: record.index,
      },
    });
  }
}
