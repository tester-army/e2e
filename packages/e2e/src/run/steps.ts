/** Attempt-scoped step timeline (spec 10-determinism.md, 13-reporting.md). */

import { classifyError, serializeError, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';

export type StepKind =
  | 'agent'
  | 'locator'
  | 'assertion'
  | 'screen'
  | 'app'
  | 'web'
  | 'device'
  | 'session'
  | 'resource';

/**
 * Child event of one public step: polls, model calls, policy decisions.
 * `tool-proposal` (report-1) belongs to the planning tier and is not emitted
 * by this milestone.
 */
export interface StepEvent {
  kind: 'poll' | 'observation' | 'model' | 'policy' | 'driver' | 'schema';
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  name?: string;
  count?: number;
  bytes?: number;
  decision?: 'allowed' | 'denied';
  code?: string;
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
 * rather than failing the step (spec 14-security.md).
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
 * `name` of the driver event covering one cache consultation. The report schema
 * closes the event-kind enum, so replay is recorded as a named `driver` event
 * rather than a new kind, and `--debug` sums the cache's cost from it.
 */
export const CACHE_REPLAY_EVENT = 'cache.replay';

export interface StepCacheInfo {
  status: 'miss' | 'hit' | 'invalid' | 'bypassed' | 'written';
  keyHash?: string;
  bytes?: number;
  /**
   * Why this status was reached, for `--debug`. Diagnostic prose and never
   * authority. Dropped when the step is serialized: `spec/schema/report-v1`
   * closes the cache object, so this field must not reach report.json.
   */
  reason?: string;
}

/**
 * How bad each cache status is for the step reporting it, so folding several
 * locates into one step keeps the outcome that cost the most.
 */
const CACHE_STATUS_SEVERITY: Record<StepCacheInfo['status'], number> = {
  hit: 0,
  written: 1,
  bypassed: 2,
  miss: 3,
  invalid: 4,
};

/**
 * Folds a second locate's cache outcome into a step that already reported one.
 *
 * A step can locate more than once — `agent.dragTo` locates a source and a
 * destination — while the report carries one cache object per step. The step
 * takes the whole record of its least favourable locate, `keyHash` included, so
 * its status and its key always describe the same locate. Both reasons are kept,
 * because the point of folding is that one locate alone does not explain the
 * step.
 *
 * A step that replayed one node but paid the model for the other did not hit,
 * and reporting it as a hit would credit the cache with a call it never avoided
 * — which is the number `--debug` prices its savings from.
 */
export function foldCacheInfo(previous: StepCacheInfo, next: StepCacheInfo): StepCacheInfo {
  const [worse, better] =
    CACHE_STATUS_SEVERITY[next.status] > CACHE_STATUS_SEVERITY[previous.status]
      ? [next, previous]
      : [previous, next];
  return { ...worse, ...joinCacheReasons(better.reason, worse.reason) };
}

/** Concatenates two cache reasons, dropping the field when there is nothing to say. */
export function joinCacheReasons(
  previous: string | undefined,
  next: string | undefined,
): { reason: string } | undefined {
  const reason = [previous, next].filter((part) => part !== undefined && part !== '').join('; ');
  return reason === '' ? undefined : { reason };
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
   * True when `vision: 'fallback'` escalated: the tree-only attempt missed, so
   * later calls of this step carried pixels and, when one is pinned, went to
   * `agent.visionModel`. `model` names the model that answered.
   */
  visionEscalated?: boolean;
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
  status: 'passed' | 'failed' | 'timed-out' | 'cancelled';
  startedAt: string;
  durationMs: number;
  observationRevision?: string;
  explanation?: string;
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  visionEscalated?: boolean;
  visionOnly?: boolean;
  viewport?: { width: number; height: number; scale: number };
  metrics?: StepMetrics;
  events: StepEvent[];
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  error?: SerializedError;
  artifacts: string[];
}

export interface StepRecorderOptions {
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
}

export class StepRecorder {
  private readonly steps: StepRecord[] = [];
  private activeStep: StepRecord | undefined;
  /** IDs of steps whose bodies are still executing. */
  private readonly running = new Set<string>();
  private readonly maxEventsPerStep: number;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
  }

  /** The step currently executing, when inside StepRecorder.run. */
  get currentStepId(): string | undefined {
    return this.activeStep?.id;
  }

  /** Runs one public API call as a recorded top-level step. */
  async run<T>(kind: StepKind, api: string, label: string, body: () => Promise<T>): Promise<T> {
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
    const previousActive = this.activeStep;
    this.activeStep = record;
    try {
      const result = await body();
      record.durationMs = Date.now() - startedMs;
      return result;
    } catch (cause) {
      record.durationMs = Date.now() - startedMs;
      const error = classifyError(cause);
      record.status = error.code === 'CANCELLED' ? 'cancelled' : 'failed';
      record.error = serializeError(error);
      throw cause;
    } finally {
      this.activeStep = previousActive;
      this.running.delete(record.id);
    }
  }

  /** Attaches an artifact ID to the most recent step, when one exists. */
  attachArtifact(artifactId: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last !== undefined) last.artifacts.push(artifactId);
  }

  /** Records one child event of the running step. */
  recordEvent(event: StepEvent): void {
    const current = this.current();
    if (current === undefined) return;
    if (current.events.length >= this.maxEventsPerStep) return;
    current.events.push(event);
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
    if (details.visionEscalated !== undefined) current.visionEscalated = details.visionEscalated;
    if (details.visionOnly !== undefined) current.visionOnly = details.visionOnly;
  }

  /** Records the viewport a step established (required for web.setViewport). */
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
    return this.activeStep;
  }
}
