/**
 * The committed-action model shared by everything that looks at what a step
 * did: one grammar action, addressed by the node it actually ran against,
 * described as a durable target descriptor plus redacted, bounded prose.
 *
 * The trace recorder stores the descriptor and the prose; the step event
 * carries the prose as `detail`; the relocator compares fresh nodes through
 * the same descriptor projection. One owner for all three, so a recorded
 * summary, a live event line, and a relocation candidate can never drift.
 */

import type { SemanticNode } from '../backend/surface.ts';
import {
  bound,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  type TraceTargetDescriptor,
} from '../cache/trace.ts';
import { sanitizeText } from '../internal/errors.ts';
import { normalizeText } from '../internal/text.ts';
import type { ScrollDirection } from '../types.ts';

/** One committed grammar action, addressed by the node it actually ran against. */
export type RecordableAction =
  | { readonly name: 'tap'; readonly node: SemanticNode }
  | { readonly name: 'type'; readonly node: SemanticNode; readonly value: string }
  | { readonly name: 'typeSecret'; readonly node: SemanticNode; readonly secret: string }
  | { readonly name: 'press'; readonly node: SemanticNode; readonly key: string }
  | { readonly name: 'select'; readonly node: SemanticNode; readonly value: string }
  | { readonly name: 'scroll'; readonly direction: ScrollDirection; readonly node?: SemanticNode }
  | { readonly name: 'navigate'; readonly url: string };

/** How one committed action reads back: where it acted, and what it did. */
export interface DescribedAction {
  /**
   * Durable descriptor of the target node; undefined for untargeted actions
   * and for nodes with nothing durable to re-find them by.
   */
  readonly target: TraceTargetDescriptor | undefined;
  /**
   * Redacted, bounded prose — `tap button "Approve"`, `fill secret
   * "password" into textbox "Password"`. Secret values never appear; the
   * secret's stable name stands in.
   */
  readonly summary: string;
}

/** Describes one committed action for recording and for the live event. */
export function describeAction(
  action: RecordableAction,
  redact: (text: string) => string,
  testIdAttribute: string,
): DescribedAction {
  const node = 'node' in action ? action.node : undefined;
  const target = node === undefined ? undefined : describeTarget(node, redact, testIdAttribute);
  const where = describeForSummary(target);
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
        return target === undefined ? `scroll ${action.direction}` : `scroll ${action.direction} on ${where}`;
      case 'navigate':
        return `navigate to ${safe(action.url)}`;
    }
  })();
  return { target, summary: bound(prose, MAX_TRACE_SUMMARY_CHARS) };
}

/**
 * Builds the durable descriptor for one resolved node: the semantic fields
 * replay re-finds it by, plus the backend's structural selector hint (kept as
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
    const collapsed = normalizeText(redact(sanitizeText(value)));
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

function describeForSummary(target: TraceTargetDescriptor | undefined): string {
  if (target === undefined) return 'the screen';
  const label = target.name ?? target.text ?? target.placeholder ?? target.testId ?? '';
  const role = target.role ?? 'node';
  return label === '' ? role : `${role} ${JSON.stringify(bound(label, 40))}`;
}

function quote(value: string): string {
  return JSON.stringify(bound(value, 40));
}
