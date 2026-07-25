/** Attempt-scoped step timeline (spec 10-determinism.md, 13-reporting.md). */

import { classifyError, serializeError, type SerializedError } from '../internal/errors.js';
import { timestamp } from '../internal/ids.js';

export type StepKind =
  | 'agent'
  | 'locator'
  | 'assertion'
  | 'screen'
  | 'app'
  | 'web'
  | 'session'
  | 'resource';

export interface StepRecord {
  id: string;
  index: number;
  kind: StepKind;
  api: string;
  label: string;
  status: 'passed' | 'failed' | 'timed-out' | 'cancelled';
  startedAt: string;
  durationMs: number;
  error?: SerializedError;
  artifacts: string[];
}

export class StepRecorder {
  private readonly steps: StepRecord[] = [];
  private activeStepId: string | undefined;

  constructor(private readonly attemptId: string) {}

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
    }
  }

  /** Attaches an artifact ID to the most recent step, when one exists. */
  attachArtifact(artifactId: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last !== undefined) last.artifacts.push(artifactId);
  }

  all(): readonly StepRecord[] {
    return this.steps;
  }
}
