/**
 * Renders one agent step and its calls for the list reporter: the same
 * finished step prints in a CI log, in a file block, and in the live window,
 * each at its own indent, so nothing here knows where the line lands.
 */

import type { HeldStep, StepPrompt } from '../run/step-hold.ts';
import type { StepRecord } from '../run/steps.ts';
import { modelLabel } from '../config/agent.ts';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import { collapseText } from '../internal/text.ts';
import {
  bounded,
  F_CHECK,
  F_CROSS,
  fitColumns,
  formatTime,
  formatTokens,
  terminalColumns,
  visibleWidth,
  type Colors,
} from './format.ts';
import type { ConfiguredModel, FinishedStep, ReplayNotice, ShownEvent } from './list-model.ts';

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_COLUMNS = 72;
/** Recording model labels stay on one bounded terminal line. */
const MAX_RECORDED_MODEL_COLUMNS = 120;
/** A clipped step line keeps at least this much of its label, however narrow the terminal. */
const MIN_STEP_LABEL_COLUMNS = 24;
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
const MIN_REASONING_COLUMNS = 24;

/** One-line, quoted step label; `maxColumns` clips it further to fit a row. */
export function quotedLabel(label: string, maxColumns = MAX_STEP_LABEL_COLUMNS): string {
  const max = Math.min(MAX_STEP_LABEL_COLUMNS, Math.max(MIN_STEP_LABEL_COLUMNS, maxColumns));
  return `"${fitColumns(collapseText(label), max)}"`;
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
  return `${head}${quotedLabel(step.label, room)} ${tail}`;
}

/** What Enter does at an `e2e run --step` prompt: it runs every step on it. */
function enterDoes(prompt: StepPrompt): string {
  return prompt.steps.length === 1 ? 'run this step' : `run these ${prompt.steps.length} steps`;
}

/** The prompt's other keys, in `--watch`'s words. */
const STEP_KEYS = [
  ['n', 'run to the next test'],
  ['a', 'run all without stopping'],
  ['q', 'quit'],
] as const;

/** Where a held step was called from, as `file:line`, or nothing. */
function promptSource(step: HeldStep): string {
  const { source } = step;
  return source === undefined ? '' : `${bounded(source.file)}:${source.line}`;
}

/**
 * A held step's prompt for the live window, under its test: the steps
 * waiting, one row each, then what to press, as `--watch` says it. Labels
 * are clipped so each call site stays on its row. The keys are one short
 * line, or every key once `h` asked for them.
 */
export function stepPromptRows(pc: Colors, prompt: StepPrompt, options: { readonly maxWidth: number }): string[] {
  const rows = prompt.steps.map(({ step, number }) => {
    const head = `${pc.bold(pc.cyan(`▶ step ${number}`))}  ${pc.dim(step.api)} `;
    const source = promptSource(step);
    const tail = source === '' ? '' : `  ${pc.dim(source)}`;
    const room = options.maxWidth - visibleWidth(head) - visibleWidth(tail) - LABEL_CHROME;
    return `${head}${quotedLabel(step.label, room)}${tail}`;
  });
  const press = (key: string, does: string): string => `${pc.dim('press')} ${pc.bold(key)} ${pc.dim(`to ${does}`)}`;
  const enter = press('enter', enterDoes(prompt));
  const keys = prompt.help
    ? [enter, ...STEP_KEYS.map(([key, does]) => press(key, does)), press('h', 'hide help')]
    : [`${enter}${pc.dim(',')} ${press('h', 'show help')}${pc.dim(',')} ${press('q', 'quit')}`];
  return [...rows, ...keys.map((line) => `  ${line}`)];
}

/** A held step's prompt as one plain line, for a terminal with no live window to show it in. */
export function stepPromptLine(prompt: StepPrompt): string {
  const [first] = prompt.steps;
  const numbers = prompt.steps.map(({ number }) => number).join(', ');
  const steps = prompt.steps.map(({ step }) => {
    const source = promptSource(step);
    return `${step.api} ${quotedLabel(step.label)}${source === '' ? '' : ` (${source})`}`;
  });
  const keys = [`enter to ${enterDoes(prompt)}`, ...STEP_KEYS.map(([key, does]) => `${key} to ${does}`)].join(', ');
  const at = prompt.steps.length === 1 ? 'step' : 'steps';
  return `paused at ${at} ${numbers} of ${bounded(first.step.title)} [${bounded(first.step.target)}]: ${steps.join('; ')} · press ${keys}`;
}

/** Recording mismatches under one test, deduplicated across its attempts. */
export function replayNotices(attempts: readonly (readonly StepRecord[])[], configured: ConfiguredModel | undefined): ReplayNotice[] {
  if (configured === undefined) return [];
  const notices = new Map<string, ReplayNotice>();
  for (const steps of attempts) {
    for (const step of steps) {
      if (step.agent !== undefined && step.agent !== configured.agent) continue;
      const source = step.cache?.recordedBy;
      if (source === undefined || step.cache?.replayedActions === 0) continue;
      const label = modelLabel({ provider: source.provider, id: source.model });
      if (label === configured.label) continue;
      const key = JSON.stringify([step.cache?.entry ?? [step.index, step.api, step.label], source.provider, source.model]);
      notices.set(key, { api: step.api, label: step.label, source });
    }
  }
  return [...notices.values()];
}

/** A recording mismatch under its test in the file block. */
export function replayLine(pc: Colors, notice: ReplayNotice): string {
  const label = modelLabel({ provider: notice.source.provider, id: notice.source.model });
  return `${pc.dim(notice.api)} ${quotedLabel(notice.label)} ${pc.dim(`replayed · recorded with ${fitColumns(collapseText(label), MAX_RECORDED_MODEL_COLUMNS)}`)}`;
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
  if (room < MIN_REASONING_COLUMNS) return undefined;
  return fitColumns(collapseText(reasoning), room);
}
