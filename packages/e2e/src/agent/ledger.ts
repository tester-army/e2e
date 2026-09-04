/**
 * Prior-step context for agent prompts (spec 10-determinism.md).
 *
 * The ledger is not stored anywhere: it is derived on demand from the step
 * timeline the run layer already records, so there is exactly one account of
 * what happened. Serial-group members see each other's prior steps through the
 * shared accumulator the run layer maintains; independent tests never do.
 * Entries are untrusted quoted evidence and never carry policy authority.
 */

import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { StepRecord } from '../run/steps.ts';
import type { ExecutorPriorStep } from './executor.ts';

/** Maximum size of one handoff, before ledger-wide compaction. */
export const MAX_HANDOFF_BYTES = 700;

const MAX_LABEL_BYTES = 256;

/** Bytes one prior-step field may occupy: sanitized quoted evidence, never policy. */
const MAX_PRIOR_STEP_FIELD_BYTES = 8_192;

/**
 * Projects recorded steps onto the executor-facing shape: the fields a brain
 * builds history from, sanitized here — the one trust boundary where step
 * records become model input — and nothing that carries runner internals.
 */
export function projectPriorSteps(records: readonly StepRecord[]): ExecutorPriorStep[] {
  return records.map((step) => ({
    index: step.index,
    kind: step.kind,
    api: step.api,
    label: boundedText(step.label),
    status: step.status,
    ...(step.explanation === undefined ? {} : { explanation: boundedText(step.explanation) }),
    ...(step.cache === undefined ? {} : { cache: step.cache.mode }),
  }));
}

function boundedText(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_PRIOR_STEP_FIELD_BYTES);
}

/** The fields one ledger entry is built from. */
type LedgerEntry = Pick<ExecutorPriorStep, 'api' | 'label' | 'status' | 'explanation'>;

export interface LedgerContext {
  readonly text: string;
  readonly bytes: number;
}

/**
 * Serializes prior steps as prompt context: newest entries first until the
 * byte budget is reached, then emitted chronologically with the dropped count
 * prepended. Takes the already-sanitized `ExecutorPriorStep` records and
 * bounds each label and handoff to the ledger's own line budget.
 */
export function serializeLedger(steps: readonly LedgerEntry[], maxBytes: number): LedgerContext {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let bytes = 0;
  let index = steps.length - 1;
  for (; index >= 0; index -= 1) {
    const line = formatEntry(steps[index]!, index + 1);
    const size = encoder.encode(`${line}\n`).byteLength;
    if (bytes + size > maxBytes) break;
    bytes += size;
    lines.push(line);
  }
  lines.reverse();
  const dropped = index + 1;
  if (dropped > 0) lines.unshift(`[${dropped} earlier step(s) omitted]`);
  const text = lines.join('\n');
  return { text, bytes: encoder.encode(text).byteLength };
}

function formatEntry(step: LedgerEntry, position: number): string {
  const label = truncateUtf8(step.label, MAX_LABEL_BYTES);
  const head = `${position}. ${step.api} ${step.status}${label === '' ? '' : ` :: ${label}`}`;
  if (step.explanation === undefined) return head;
  const handoff = truncateUtf8(step.explanation, MAX_HANDOFF_BYTES);
  return `${head}\n   observed: ${handoff}`;
}
