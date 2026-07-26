/** Attempt-scoped step timeline (spec 10-determinism.md, 13-reporting.md). */

import type { Ledger } from '../agent/ledger.ts';
import { classifyError, serializeError, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';

export type StepKind =
  | 'agent'
  | 'locator'
  | 'assertion'
  | 'screen'
  | 'app'
  | 'web'
  | 'session'
  | 'resource';

/** Child event of one public step: polls, model calls, policy decisions. */
export interface StepEvent {
  kind: 'poll' | 'observation' | 'model' | 'tool-proposal' | 'policy' | 'driver' | 'schema';
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
}

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

export interface StepCacheInfo {
  status: 'miss' | 'hit' | 'invalid' | 'bypassed' | 'written';
  keyHash?: string;
  bytes?: number;
}

/** Agent-specific step detail attached while the step is still running. */
export interface StepAgentDetails {
  metrics?: StepMetrics;
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  observationRevision?: string;
  explanation?: string;
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
  viewport?: { width: number; height: number; scale: number };
  metrics?: StepMetrics;
  events: StepEvent[];
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  error?: SerializedError;
  artifacts: string[];
}

export interface StepRecorderOptions {
  /** Appends completed steps as prior-step context for agent invocations. */
  readonly ledger?: Ledger;
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
}

export class StepRecorder {
  private readonly steps: StepRecord[] = [];
  private activeStepId: string | undefined;
  private readonly ledger: Ledger | undefined;
  private readonly maxEventsPerStep: number;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.ledger = options.ledger;
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
  }

  /** The step currently executing, when inside StepRecorder.run. */
  get currentStepId(): string | undefined {
    return this.activeStepId;
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
    const previousActive = this.activeStepId;
    this.activeStepId = record.id;
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
      this.activeStepId = previousActive;
      this.ledger?.append({
        method: record.api,
        label: record.label,
        status: record.status,
        ...(record.explanation !== undefined ? { handoff: record.explanation } : {}),
      });
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
  }

  /** Records the viewport a step established (required for web.setViewport). */
  attachViewport(viewport: { width: number; height: number; scale: number }): void {
    const current = this.current();
    if (current !== undefined) current.viewport = viewport;
  }

  all(): readonly StepRecord[] {
    return this.steps;
  }

  private current(): StepRecord | undefined {
    if (this.activeStepId === undefined) return undefined;
    return this.steps.find((step) => step.id === this.activeStepId);
  }
}
