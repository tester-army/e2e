/**
 * Step trace recording.
 *
 * Records every grammar action a step commits, capturing a durable target
 * descriptor at commit time — the moment the harness resolved the node — so
 * replay can re-find it against a fresh observation. Recording is
 * defense-in-depth on secrets: callers already hand secret-free input
 * (`typeSecret` contributes only the secret's stable name), and every string
 * that could carry screen content is additionally passed through the run's
 * redactor before it can reach disk.
 *
 * Replay inputs are verbatim or nothing. A value the redactor would alter, or
 * one over the input cap, poisons the trace (`truncated`) instead of being
 * bent to fit: a trimmed URL or half a typed value would replay a different
 * action than the one recorded, and could self-finalize a step on the wrong
 * state. A poisoned trace still documents what happened; it never replays.
 */

import { describeAction, type RecordableAction } from '../agent/actions.ts';
import {
  bound,
  MAX_TRACE_ACTIONS,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_END_WAIT_MS,
  MAX_TRACE_INPUT_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  type ActionTrace,
  type RecordedAction,
  type TraceProvenance,
  type TraceTargetDescriptor,
} from './trace.ts';

export interface TraceRecorderOptions {
  /** The run's secret redactor; applied to every recorded string. */
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
  readonly maxActions?: number;
}

export class TraceRecorder {
  private readonly actions: RecordedAction[] = [];
  private truncated = false;
  private readonly redact: (text: string) => string;
  private readonly testIdAttribute: string;
  private readonly maxActions: number;

  constructor(options: TraceRecorderOptions) {
    this.redact = options.redact;
    this.testIdAttribute = options.testIdAttribute;
    this.maxActions = Math.min(options.maxActions ?? MAX_TRACE_ACTIONS, MAX_TRACE_ACTIONS);
  }

  /** Number of actions recorded so far, gaps included. */
  get recordedCount(): number {
    return this.actions.length;
  }

  /** Records one committed grammar action. */
  record(action: RecordableAction): void {
    const { target, summary } = describeAction(action, this.redact, this.testIdAttribute);
    this.push(this.toRecorded(action, target, summary));
  }

  /**
   * Records one mutating project-tool call as a gap. Replay ends here rather
   * than skipping it: the grammar cannot reproduce the mutation, and a replay
   * that silently dropped a state change would prove nothing.
   */
  recordGap(toolName: string): void {
    this.push({ name: 'tool', summary: bound(`tool ${this.redact(toolName)}`, MAX_TRACE_SUMMARY_CHARS) });
  }

  /**
   * Concludes recording into a trace, or undefined when nothing was recorded —
   * a step that committed no actions has no flow worth replaying.
   */
  finalize(conclusion: {
    readonly executor: { readonly name: string; readonly version?: string };
    /** Test, target, and instruction digest the trace was recorded for. */
    readonly recordedFor: TraceProvenance;
    readonly summary: string;
    readonly startPath?: string;
    readonly endPath?: string;
    /** Already projected and capped by `describeAnchors`; recorded as given. */
    readonly endAnchors?: readonly TraceTargetDescriptor[];
    /** How long the recorded run took to reach its end state, plus margin. */
    readonly endWaitMs?: number;
  }): ActionTrace | undefined {
    if (this.actions.length === 0) return undefined;
    const summary = bound(this.redact(conclusion.summary), MAX_TRACE_SUMMARY_CHARS);
    // Anchors are replay preconditions, so they follow the input rule: a path
    // the redactor alters carried a secret (a token in a query string) and
    // the trace is marked non-replayable rather than storing it verbatim.
    const startPath = this.anchorPath(conclusion.startPath);
    const endPath = this.anchorPath(conclusion.endPath);
    return {
      actions: [...this.actions],
      executor: {
        name: conclusion.executor.name,
        ...(conclusion.executor.version === undefined ? {} : { version: conclusion.executor.version }),
      },
      recordedFor: {
        // Harness identity rather than screen content, so the redactor here is
        // belt and braces: a title that happened to carry a registered secret
        // is masked like any other recorded string, and provenance is not
        // replay input, so masking it poisons nothing.
        testId: bound(this.redact(conclusion.recordedFor.testId), MAX_TRACE_DESCRIPTOR_CHARS),
        targetId: bound(this.redact(conclusion.recordedFor.targetId), MAX_TRACE_DESCRIPTOR_CHARS),
        instructionDigest: conclusion.recordedFor.instructionDigest,
      },
      summary: summary.trim() === '' ? 'step passed' : summary,
      ...(startPath === undefined ? {} : { startPath }),
      ...(endPath === undefined ? {} : { endPath }),
      ...(conclusion.endAnchors === undefined || conclusion.endAnchors.length === 0
        ? {}
        : { endAnchors: conclusion.endAnchors }),
      ...(conclusion.endWaitMs === undefined
        ? {}
        : { endWaitMs: Math.min(MAX_TRACE_END_WAIT_MS, Math.max(0, Math.round(conclusion.endWaitMs))) }),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  private anchorPath(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined;
    const redacted = this.redact(value);
    if (redacted !== value) this.truncated = true;
    return bound(redacted, MAX_TRACE_DESCRIPTOR_CHARS);
  }

  /**
   * Builds the stored variant for one action. The descriptor and the prose
   * come from `describeAction` — already redacted and bounded, and the same
   * text the live event carried. Stored inputs still go through `verbatim`,
   * whose poisoning marks the trace non-replayable when a value cannot be
   * kept whole.
   */
  private toRecorded(
    action: RecordableAction,
    target: TraceTargetDescriptor | undefined,
    summary: string,
  ): RecordedAction {
    // A targeted commit whose node yields no durable descriptor cannot be
    // re-found; the trace stays honest by poisoning instead of guessing.
    const requireTarget = (): TraceTargetDescriptor => {
      if (target !== undefined) return target;
      this.truncated = true;
      return { role: 'unknown' };
    };
    switch (action.name) {
      case 'tap':
        return { name: 'tap', summary, target: requireTarget() };
      case 'type':
        return { name: 'type', summary, target: requireTarget(), value: this.verbatim(action.value) };
      case 'typeSecret':
        return { name: 'typeSecret', summary, target: requireTarget(), secret: action.secret };
      case 'press':
        return { name: 'press', summary, target: requireTarget(), key: this.verbatim(action.key) };
      case 'select':
        return { name: 'select', summary, target: requireTarget(), value: this.verbatim(action.value) };
      case 'scroll':
        return {
          name: 'scroll',
          summary,
          direction: action.direction,
          ...(target === undefined ? {} : { target }),
        };
      case 'navigate':
        return { name: 'navigate', summary, url: this.verbatim(action.url) };
      case 'tapAt': {
        // The point replays as given on a same-sized viewport. When a listed
        // node with a durable descriptor contained it, its place inside that
        // node's box is kept too, so replay can follow the node instead.
        const box = action.under?.rect;
        const within =
          target === undefined || box === undefined || box.width <= 0 || box.height <= 0
            ? undefined
            : { target, fx: fraction((action.point.x - box.x) / box.width), fy: fraction((action.point.y - box.y) / box.height) };
        return {
          name: 'tapAt',
          summary,
          point: action.point,
          viewport: { width: action.viewport.width, height: action.viewport.height },
          ...(within === undefined ? {} : { within }),
        };
      }
    }
  }

  /**
   * A replay input, verbatim or poisoned. A value the redactor alters carried
   * a registered secret; an oversized one cannot be stored whole. Either way
   * the trace is marked non-replayable and a redacted, bounded copy is kept
   * for documentation only.
   */
  private verbatim(value: string): string {
    const redacted = this.redact(value);
    if (redacted === value && value.length <= MAX_TRACE_INPUT_CHARS) return value;
    this.truncated = true;
    return bound(redacted, MAX_TRACE_INPUT_CHARS);
  }

  private push(action: RecordedAction): void {
    if (this.actions.length >= this.maxActions) {
      this.truncated = true;
      return;
    }
    this.actions.push(action);
  }
}

/** A place inside a box as a fraction of its side, clamped to the box and rounded so the entry stays small. */
function fraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}
