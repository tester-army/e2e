/** Attempt-scoped step timeline. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAgentError } from '../agent/error.ts';
import type { ReplayHandOffReason } from '../agent/executor.ts';
import type { TraceReplayMissReason } from '../cache/decide.ts';
import { withAiTraceStep } from '../internal/ai-trace.ts';
import { classifyError, serializeError, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';

export type StepKind =
  | 'agent'
  | 'locator'
  | 'assertion'
  | 'screen'
  | 'app'
  | 'session'
  | 'resource';

/**
 * Child event of one public step: polls, model calls, policy decisions.
 * `tool-proposal` (report-1) belongs to the planning tier and is not emitted
 * by this milestone.
 */
export interface StepEvent {
  kind: 'poll' | 'observation' | 'model' | 'policy' | 'engine' | 'schema';
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  name?: string;
  count?: number;
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
  replayedActions: number;
  totalActions: number;
}

/** Agent-specific step detail attached while the step is still running. */
export interface StepAgentDetails {
  metrics?: StepMetrics;
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  observationRevision?: string;
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
}

export interface StepRecord {
  id: string;
  index: number;
  kind: StepKind;
  api: string;
  label: string;
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
  model?: StepModelInfo;
  error?: SerializedError;
  artifacts: string[];
}

/**
 * Live progress notification for one step, streamed to reporters as the step
 * runs. Derived from the same records the report persists; the report stays
 * the canonical record.
 */
export type StepProgress =
  | { readonly phase: 'start'; readonly kind: StepKind; readonly api: string; readonly label: string }
  | {
      readonly phase: 'end';
      readonly kind: StepKind;
      readonly api: string;
      readonly label: string;
      readonly status: StepRecord['status'];
      readonly durationMs: number;
      readonly modelCalls: number;
    }
  | { readonly phase: 'event'; readonly api: string; readonly event: StepEvent };

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
}

export interface StepRecorderOptions {
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
  /** Live progress sink; omitted in contexts with no reporter to feed. */
  readonly onProgress?: (progress: StepProgress) => void;
}

export class StepRecorder {
  private readonly steps: StepRecord[] = [];
  private readonly scope = new AsyncLocalStorage<StepRecord>();
  /** IDs of steps whose bodies are still executing. */
  private readonly running = new Set<string>();
  /** Highest timeline index among passed verification steps, or -1 when none has. */
  private lastVerified = -1;
  private readonly maxEventsPerStep: number;
  private readonly onProgress: ((progress: StepProgress) => void) | undefined;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
    this.onProgress = options.onProgress;
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
  async run<T>(
    kind: StepKind,
    api: string,
    label: string,
    body: () => Promise<T>,
    options: StepRunOptions = {},
  ): Promise<T> {
    const index = this.steps.length;
    const startedAt = timestamp();
    const startedMs = Date.now();
    const record: StepRecord = {
      id: `${this.attemptId}:${index}`,
      index,
      kind,
      api,
      label,
      status: 'passed',
      startedAt,
      durationMs: 0,
      events: [],
      artifacts: [],
    };
    this.steps.push(record);
    this.running.add(record.id);
    this.onProgress?.({ phase: 'start', kind, api, label });
    try {
      // Model calls made inside the body are attributed to this step.
      const result = await this.scope.run(record, () => withAiTraceStep(api, label, body));
      record.durationMs = Date.now() - startedMs;
      if (options.verifies === true) this.lastVerified = Math.max(this.lastVerified, index);
      return result;
    } catch (cause) {
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
      record.error = serializeError(error);
      throw cause;
    } finally {
      this.running.delete(record.id);
      this.onProgress?.({
        phase: 'end',
        kind,
        api,
        label,
        status: record.status,
        durationMs: record.durationMs,
        modelCalls: record.events.filter((event) => event.kind === 'model').length,
      });
    }
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
    this.onProgress?.({ phase: 'event', api: current.api, event });
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
    if (details.explanation !== undefined) current.explanation = details.explanation;
    if (details.visionInput !== undefined) current.visionInput = details.visionInput;
    if (details.visionDegraded !== undefined) current.visionDegraded = details.visionDegraded;
    if (details.visionOnly !== undefined) current.visionOnly = details.visionOnly;
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
    return record !== undefined && this.running.has(record.id) ? record : undefined;
  }
}
