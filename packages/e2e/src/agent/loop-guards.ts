/**
 * Loop guards: pure detectors over the tool-call transcript that catch an
 * executor loop going in circles before the budget does. Ported from the
 * shape proven in production — a wandering model repeats itself long before
 * it runs out of calls, and every repeated turn is spent money.
 *
 * A guard never invents a verdict: a warning injects a notice the model can
 * react to, and a stop forces the conclusion tool so the model still writes
 * its own summary. Budgets remain the outer bound either way.
 */

import type { ModelMessage } from 'ai';

/** One tool call as identity: the name plus its exact serialized input. */
export interface GuardToolCall {
  readonly toolName: string;
  readonly input: string;
}

export type LoopGuardVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'warn' | 'stop'; readonly reason: string };

/** Longest cycle period the detector considers. */
const MAX_CYCLE_PERIOD = 4;

/**
 * Guard thresholds. Identical-call (period 1) counts are consecutive
 * repetitions of one call; cycle (period 2..4) counts are whole repetitions
 * of the sequence. Each warns first, then forces the conclusion.
 */
export interface LoopGuardThresholds {
  readonly repeatWarn: number;
  readonly repeatStop: number;
  readonly cycleWarn: number;
  readonly cycleStop: number;
  /** Consecutive failed tool results that warn, then force the conclusion. */
  readonly failureWarn: number;
  readonly failureStop: number;
}

/** The thresholds the built-in agent ships with. */
export const DEFAULT_LOOP_GUARD_THRESHOLDS: LoopGuardThresholds = {
  repeatWarn: 3,
  repeatStop: 5,
  cycleWarn: 2,
  cycleStop: 3,
  failureWarn: 3,
  failureStop: 5,
};

/**
 * Extracts the tool-call identity sequence from a model transcript,
 * excluding the conclusion tool: concluding attempts are never "loops".
 */
export function extractGuardCalls(
  messages: readonly ModelMessage[],
  concludeToolName: string,
): GuardToolCall[] {
  const calls: GuardToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName === concludeToolName) continue;
      calls.push({ toolName: part.toolName, input: safeStringify(part.input) });
    }
  }
  return calls;
}

/**
 * Checks the trailing calls for exact repetition (period 1) and short exact
 * cycles (periods 2..4). Identity includes the serialized input, so two taps
 * on different targets never count as a repeat — only literally re-issuing
 * the same work does.
 */
export function checkLoopGuards(
  calls: readonly GuardToolCall[],
  thresholds: LoopGuardThresholds = DEFAULT_LOOP_GUARD_THRESHOLDS,
): LoopGuardVerdict {
  let warning: LoopGuardVerdict | undefined;
  for (let period = 1; period <= MAX_CYCLE_PERIOD; period += 1) {
    const repeats = trailingRepeats(calls, period);
    const [warnAt, stopAt] =
      period === 1
        ? [thresholds.repeatWarn, thresholds.repeatStop]
        : [thresholds.cycleWarn, thresholds.cycleStop];
    if (repeats >= stopAt) {
      return { kind: 'stop', reason: describe(calls, period, repeats) };
    }
    if (repeats >= warnAt && warning === undefined) {
      warning = { kind: 'warn', reason: describe(calls, period, repeats) };
    }
  }
  return warning ?? { kind: 'clear' };
}

/** How many times the trailing window of `period` calls repeats consecutively. */
function trailingRepeats(calls: readonly GuardToolCall[], period: number): number {
  if (calls.length < period) return 0;
  // A period-p cycle must not be a disguised shorter cycle: "A A A A" matches
  // period 2 as well, but period 1 owns it and applies the stricter policy.
  if (period > 1 && isUniformWindow(calls, period)) return 0;
  const same = (a: GuardToolCall | undefined, b: GuardToolCall | undefined): boolean =>
    a !== undefined && b !== undefined && a.toolName === b.toolName && a.input === b.input;
  let repeats = 1;
  for (let offset = period; calls.length - offset - period >= 0; offset += period) {
    let matches = true;
    for (let index = 0; index < period; index += 1) {
      if (!same(calls[calls.length - period + index], calls[calls.length - offset - period + index])) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
    repeats += 1;
  }
  return repeats;
}

/** True when the trailing window consists of one identical call repeated. */
function isUniformWindow(calls: readonly GuardToolCall[], period: number): boolean {
  const first = calls[calls.length - period];
  if (first === undefined) return false;
  for (let index = 1; index < period; index += 1) {
    const call = calls[calls.length - period + index];
    if (call === undefined || call.toolName !== first.toolName || call.input !== first.input) {
      return false;
    }
  }
  return true;
}

function describe(calls: readonly GuardToolCall[], period: number, repeats: number): string {
  const names = calls
    .slice(calls.length - period)
    .map((call) => call.toolName)
    .join(', ');
  return period === 1
    ? `the same "${names}" call with identical input was issued ${repeats} times in a row`
    : `the same ${period}-call sequence (${names}) repeated ${repeats} times with identical inputs`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/**
 * Extracts the text of every tool result in a transcript, in order, excluding
 * the conclusion tool's. Only text results count: a structured result is a
 * project tool's own shape and says nothing about failure.
 */
export function extractToolResults(messages: readonly ModelMessage[], concludeToolName: string): string[] {
  const results: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.toolName === concludeToolName) continue;
      const output = part.output;
      if (output.type === 'text' && typeof output.value === 'string') results.push(output.value);
    }
  }
  return results;
}

/**
 * Whether a tool result reports its action failing, by the first line's
 * shape: `Tapped #n6. failed: …` from a grammar action, `Action failed: …`
 * from the loop's guard, `Tool "x" failed: …` from a project tool.
 */
export function isFailedResult(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? '';
  return /(?:^|\. )(?:Action |Tool "[^"]*" )?failed: /.test(first);
}

/**
 * Checks the trailing run of failed results. Different targets or inputs do
 * not save a streak: five failures in a row say the approach is wrong, not
 * that the last id was. Warns first, then forces the conclusion.
 */
export function checkFailureStreak(
  results: readonly string[],
  thresholds: LoopGuardThresholds = DEFAULT_LOOP_GUARD_THRESHOLDS,
): LoopGuardVerdict {
  let streak = 0;
  for (let index = results.length - 1; index >= 0 && isFailedResult(results[index]!); index -= 1) streak += 1;
  if (streak >= thresholds.failureStop) {
    return { kind: 'stop', reason: `the last ${String(streak)} actions failed in a row` };
  }
  if (streak >= thresholds.failureWarn) {
    return { kind: 'warn', reason: `the last ${String(streak)} actions failed in a row` };
  }
  return { kind: 'clear' };
}
