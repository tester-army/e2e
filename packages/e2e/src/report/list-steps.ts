/**
 * Renders one agent step and its calls for the list reporter: the same
 * finished step prints in a CI log, in a file block, and in the live window,
 * each at its own indent, so nothing here knows where the line lands.
 */

import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { collapseText } from '../internal/text.ts';
import {
  ellipsize,
  F_CHECK,
  F_CROSS,
  formatTime,
  formatTokens,
  terminalColumns,
  visibleWidth,
  type Colors,
} from './format.ts';
import type { FinishedStep, ShownEvent } from './list-model.ts';

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_CHARS = 72;
/** A clipped step line keeps at least this much of its label, however narrow the terminal. */
const MIN_STEP_LABEL_CHARS = 24;
/** Columns a step line spends around its label: the quotes and the space before the tail. */
const LABEL_CHROME = 3;
/** A finished model turn. */
const F_MODEL = '•';
/** A tool call the model made. */
const F_TOOL = '›';
const F_INPUT = '↑';
const F_OUTPUT = '↓';
/** Columns the ` · ` between a turn's timing and its reasoning excerpt takes. */
const REASONING_SEPARATOR_WIDTH = 3;
/** A narrower clip than this hides more than it says; the excerpt is dropped instead. */
const MIN_REASONING_CHARS = 24;

/** One-line, quoted step label; `maxChars` clips it further to fit a row. */
export function stepLabel(label: string, maxChars = MAX_STEP_LABEL_CHARS): string {
  const max = Math.min(MAX_STEP_LABEL_CHARS, Math.max(MIN_STEP_LABEL_CHARS, maxChars));
  return `"${ellipsize(collapseText(label), max)}"`;
}

export interface StepLineOptions {
  /** Text before the api, naming the test when the line prints away from it. */
  readonly context?: string;
  /** Printed width the line may take; the label is clipped so the tail stays on the row. */
  readonly maxWidth?: number;
}

/**
 * One finished agent step: outcome glyph, api, quoted label, then duration,
 * model calls, and a non-passed status.
 */
export function stepLine(pc: Colors, step: FinishedStep, options: StepLineOptions = {}): string {
  const glyph = step.status === 'passed' ? pc.green(F_CHECK) : pc.red(F_CROSS);
  const calls =
    step.modelCalls > 0 ? ` · ${step.modelCalls} model call${step.modelCalls === 1 ? '' : 's'}` : '';
  const outcome = step.status === 'passed' ? '' : ` ${step.status}`;
  const head = `${glyph} ${options.context ?? ''}${pc.dim(step.api)} `;
  const tail = pc.dim(`${formatTime(step.durationMs)}${calls}${outcome}`);
  const room =
    options.maxWidth === undefined
      ? undefined
      : options.maxWidth - visibleWidth(head) - visibleWidth(tail) - LABEL_CHROME;
  return `${head}${stepLabel(step.label, room)} ${tail}`;
}

/**
 * `(↑in ↓out)` for one model call, the total when only that is known, or
 * nothing when the provider reported no usage.
 */
function tokenSplit(event: ShownEvent): string {
  if (event.inputTokens !== undefined && event.outputTokens !== undefined) {
    return ` (${F_INPUT}${formatTokens(event.inputTokens)} ${F_OUTPUT}${formatTokens(event.outputTokens)})`;
  }
  return event.count !== undefined && event.count > 0 ? ` (${formatTokens(event.count)} tokens)` : '';
}

/**
 * One model turn or tool call under the current step. A tool call reads as
 * the act it performed when the engine described it, else as the tool name
 * (`tool:` prefixes come from executor tool accounting). A model turn the
 * model reasoned its way through appends an excerpt of that reasoning,
 * clipped to the row: why it acted, not just that it did.
 */
export function eventLine(pc: Colors, event: ShownEvent, options: { maxWidth?: number } = {}): string {
  if (event.kind === 'model') {
    const head = `${F_MODEL} Thinking (${formatTime(event.durationMs)})${tokenSplit(event)}`;
    const reasoning = reasoningExcerpt(event.reasoning, visibleWidth(head), options.maxWidth);
    return pc.dim(reasoning === undefined ? head : `${head} · ${reasoning}`);
  }
  const name = sanitizeText(event.name ?? 'engine').replace(/^tool:/, '');
  const act = event.detail === undefined ? name : sanitizeText(collapseText(event.detail));
  const failed = event.status === 'passed' ? '' : ` ${pc.red(F_CROSS)}`;
  return `${pc.dim(`${F_TOOL} ${truncateUtf8(act, 60)} (${formatTime(event.durationMs)})`)}${failed}`;
}

/**
 * The one-line form of a turn's reasoning for its Thinking row, or undefined
 * when the row has no room worth reading at.
 */
function reasoningExcerpt(reasoning: string | undefined, headWidth: number, maxWidth?: number): string | undefined {
  if (reasoning === undefined) return undefined;
  const room = (maxWidth ?? terminalColumns()) - headWidth - REASONING_SEPARATOR_WIDTH;
  if (room < MIN_REASONING_CHARS) return undefined;
  return ellipsize(collapseText(reasoning), room);
}
