/**
 * Whether a typed value is the step's own data or data it derived at run
 * time.
 *
 * A value the instruction or the params spell out — "Nimbus Paper Co", 4.25,
 * a param's string — is the step's literal input and replays verbatim. A
 * value found nowhere in them came from somewhere else: the screen, an
 * earlier step's hand-off, the model's own reckoning of a date or a code.
 * That value belongs to THIS run; the next run's app may issue another, and a
 * replay that typed the old one would act out a stale flow and self-finalize
 * on the wrong state. Such an action is recorded as a gap instead: replay
 * performs everything before it and hands the step over, so the executor
 * derives the value afresh from what it sees and remembers.
 */

import type { JsonValue } from '../types.ts';

export function isDerivedValue(
  value: string,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
): boolean {
  const needle = normalize(value);
  if (needle === '') return false;
  if (normalize(instruction).includes(needle)) return false;
  return !paramStrings(params).some((text) => normalize(text).includes(needle));
}

/** Every string and number a params object carries, at any depth. */
function paramStrings(params: Readonly<Record<string, JsonValue>> | undefined): string[] {
  const out: string[] = [];
  const visit = (value: JsonValue): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  };
  if (params !== undefined) visit(params);
  return out;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
