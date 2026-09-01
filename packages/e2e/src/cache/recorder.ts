/**
 * Step trace recording (RFC0001 layer 3, cache-in decision).
 *
 * Records every grammar action a step commits, capturing a durable target
 * descriptor at commit time — the moment the harness resolved the node — so
 * replay can re-find it against a fresh observation. Recording is
 * defense-in-depth on secrets: callers already hand secret-free input
 * (`typeSecret` contributes only the secret's stable name), and every string
 * that could carry page content is additionally passed through the run's
 * redactor before it can reach disk.
 *
 * Replay inputs are verbatim or nothing. A value the redactor would alter, or
 * one over the input cap, poisons the trace (`truncated`) instead of being
 * bent to fit: a trimmed URL or half a typed value would replay a different
 * action than the one recorded, and could self-finalize a step on the wrong
 * state. A poisoned trace still documents what happened; it never replays.
 */

import type { SemanticNode } from '../driver/index.ts';
import { sanitizeText } from '../internal/errors.ts';
import type { ScrollDirection } from '../types.ts';
import {
  MAX_TRACE_ACTIONS,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_INPUT_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  type ActionTrace,
  type RecordedAction,
  type TraceTargetDescriptor,
} from './trace.ts';

/** One committed grammar action, addressed by the node it actually ran against. */
export type RecordableAction =
  | { readonly name: 'tap'; readonly node: SemanticNode }
  | { readonly name: 'type'; readonly node: SemanticNode; readonly value: string }
  | { readonly name: 'typeSecret'; readonly node: SemanticNode; readonly secret: string }
  | { readonly name: 'press'; readonly node: SemanticNode; readonly key: string }
  | { readonly name: 'select'; readonly node: SemanticNode; readonly value: string }
  | { readonly name: 'scroll'; readonly direction: ScrollDirection; readonly node?: SemanticNode }
  | { readonly name: 'navigate'; readonly url: string };

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

  /** Records one committed grammar action. */
  record(action: RecordableAction): void {
    const target =
      action.name === 'navigate' || action.node === undefined
        ? undefined
        : describeTarget(action.node, this.redact, this.testIdAttribute);
    this.push(this.toRecorded(action, target));
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
    readonly summary: string;
    readonly startPath?: string;
    readonly endPath?: string;
  }): ActionTrace | undefined {
    if (this.actions.length === 0) return undefined;
    const summary = bound(this.redact(conclusion.summary), MAX_TRACE_SUMMARY_CHARS);
    return {
      actions: [...this.actions],
      executor: {
        name: conclusion.executor.name,
        ...(conclusion.executor.version === undefined ? {} : { version: conclusion.executor.version }),
      },
      summary: summary.trim() === '' ? 'step passed' : summary,
      ...(conclusion.startPath === undefined || conclusion.startPath === ''
        ? {}
        : { startPath: bound(conclusion.startPath, MAX_TRACE_DESCRIPTOR_CHARS) }),
      ...(conclusion.endPath === undefined || conclusion.endPath === ''
        ? {}
        : { endPath: bound(conclusion.endPath, MAX_TRACE_DESCRIPTOR_CHARS) }),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  private toRecorded(
    action: RecordableAction,
    target: TraceTargetDescriptor | undefined,
  ): RecordedAction {
    // A targeted commit whose node yields no durable descriptor cannot be
    // re-found; the trace stays honest by poisoning instead of guessing.
    const requireTarget = (): TraceTargetDescriptor => {
      if (target !== undefined) return target;
      this.truncated = true;
      return { role: 'unknown' };
    };
    const where = describeForSummary(target);
    // Safe values are derived first and used for both the stored input and
    // the summary, so a value the redactor rewrites can never leak through
    // the prose either.
    switch (action.name) {
      case 'tap':
        return { name: 'tap', summary: bound(`tap ${where}`, MAX_TRACE_SUMMARY_CHARS), target: requireTarget() };
      case 'type': {
        const value = this.verbatim(action.value);
        return {
          name: 'type',
          summary: bound(`type ${quote(value)} into ${where}`, MAX_TRACE_SUMMARY_CHARS),
          target: requireTarget(),
          value,
        };
      }
      case 'typeSecret':
        return {
          name: 'typeSecret',
          summary: bound(`fill secret ${quote(action.secret)} into ${where}`, MAX_TRACE_SUMMARY_CHARS),
          target: requireTarget(),
          secret: action.secret,
        };
      case 'press': {
        const key = this.verbatim(action.key);
        return {
          name: 'press',
          summary: bound(`press ${quote(key)} on ${where}`, MAX_TRACE_SUMMARY_CHARS),
          target: requireTarget(),
          key,
        };
      }
      case 'select': {
        const value = this.verbatim(action.value);
        return {
          name: 'select',
          summary: bound(`select ${quote(value)} in ${where}`, MAX_TRACE_SUMMARY_CHARS),
          target: requireTarget(),
          value,
        };
      }
      case 'scroll':
        return {
          name: 'scroll',
          summary: bound(
            target === undefined ? `scroll ${action.direction}` : `scroll ${action.direction} on ${where}`,
            MAX_TRACE_SUMMARY_CHARS,
          ),
          direction: action.direction,
          ...(target === undefined ? {} : { target }),
        };
      case 'navigate': {
        const url = this.verbatim(action.url);
        return {
          name: 'navigate',
          summary: bound(`navigate to ${quote(url)}`, MAX_TRACE_SUMMARY_CHARS),
          url,
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

/**
 * Builds the durable descriptor for one resolved node: the semantic fields
 * replay re-finds it by, plus the driver's structural selector hint (kept as
 * provenance for tuned policies; the conservative relocator ignores it).
 * Values a secure node holds are never part of it — descriptors carry how a
 * node is named, not what it contains.
 */
export function describeTarget(
  node: SemanticNode,
  redact: (text: string) => string,
  testIdAttribute: string,
): TraceTargetDescriptor | undefined {
  const field = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const collapsed = redact(sanitizeText(value)).replace(/\s+/g, ' ').trim();
    return collapsed === '' ? undefined : bound(collapsed, MAX_TRACE_DESCRIPTOR_CHARS);
  };
  const role = field(node.role);
  const name = field(node.name);
  const text = field(node.text);
  const testId = field(node.attributes?.[testIdAttribute]);
  const placeholder = field(node.attributes?.['placeholder']);
  const selector = node.selector === undefined ? undefined : bound(node.selector, MAX_TRACE_DESCRIPTOR_CHARS);
  const inputPurpose =
    node.inputPurpose === undefined || node.inputPurpose === 'none' ? undefined : node.inputPurpose;
  const descriptor: TraceTargetDescriptor = {
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined || text === name ? {} : { text }),
    ...(testId === undefined ? {} : { testId }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(selector === undefined ? {} : { selector }),
    ...(inputPurpose === undefined ? {} : { inputPurpose }),
  };
  return Object.keys(descriptor).length === 0 ? undefined : descriptor;
}

/**
 * Redacted, bounded prose for one grammar action, independent of any
 * recorder: step events carry it as `detail` so a live reporter can render
 * the act without a side lookup. Wording mirrors the recorded trace
 * summaries; secret values never appear (the stable name stands in).
 */
export function summarizeAction(
  action: RecordableAction,
  redact: (text: string) => string,
  testIdAttribute: string,
): string {
  const node = 'node' in action ? action.node : undefined;
  const where = describeForSummary(
    node === undefined ? undefined : describeTarget(node, redact, testIdAttribute),
  );
  const safe = (value: string) => quote(redact(sanitizeText(value)));
  const prose = (() => {
    switch (action.name) {
      case 'tap':
        return `tap ${where}`;
      case 'type':
        return `type ${safe(action.value)} into ${where}`;
      case 'typeSecret':
        return `fill secret ${quote(action.secret)} into ${where}`;
      case 'press':
        return `press ${safe(action.key)} on ${where}`;
      case 'select':
        return `select ${safe(action.value)} in ${where}`;
      case 'scroll':
        return node === undefined ? `scroll ${action.direction}` : `scroll ${action.direction} on ${where}`;
      case 'navigate':
        return `navigate to ${safe(action.url)}`;
    }
  })();
  return bound(prose, MAX_TRACE_SUMMARY_CHARS);
}

function describeForSummary(target: TraceTargetDescriptor | undefined): string {
  if (target === undefined) return 'the page';
  const label = target.name ?? target.text ?? target.placeholder ?? target.testId ?? '';
  const role = target.role ?? 'node';
  return label === '' ? role : `${role} ${JSON.stringify(bound(label, 40))}`;
}

function quote(value: string): string {
  return JSON.stringify(bound(value, 40));
}

function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
