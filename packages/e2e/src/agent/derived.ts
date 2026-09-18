/**
 * Whether a value the executor typed was derived at run time, so the trace
 * must not replay it.
 *
 * A value the instruction or the params spell out — "Nimbus Paper Co", 4.25,
 * a param's string — is the step's literal input and replays verbatim. A
 * value the step read off the screen (a code, a reference the app minted),
 * or reckoned from the calendar, belongs to THIS run: the next run's app may
 * issue another, and a replay that typed the old one would act out a stale
 * flow and self-finalize on the wrong state. Such an action is recorded as a
 * gap instead: replay performs everything before it and hands the step over,
 * so the executor derives the value afresh from what it sees and remembers.
 * A value the model composed itself (a plausible name, an email, a note)
 * is the flow's data as much as a literal would be, and replays.
 */

import type { JsonValue } from '../types.ts';

/**
 * `shown` is what the screens of the step displayed, one string per node
 * (`ObservationFeed.shownText`): the fields that echo a typed value are
 * already left out of it.
 */
export function isDerivedValue(
  value: string,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
  shown: Iterable<string> = [],
): boolean {
  const needle = normalize(value);
  if (needle === '') return false;
  if (normalize(instruction).includes(needle)) return false;
  if (paramStrings(params).some((text) => normalize(text).includes(needle))) return false;
  // Read off the screen (a code, a reference, a name the app minted) or
  // reckoned from the calendar: this run's data. Anything else the model
  // composed itself, and the next run's app takes it as readily.
  for (const text of shown) {
    if (hasWord(normalize(text), needle)) return true;
  }
  return DATE_OR_TIME.test(value);
}

/**
 * Whether the text carries the value as a whole token: "Jane" inside
 * "Janet" is not the screen showing it.
 */
function hasWord(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : text[at - 1]!;
    const after = at + needle.length >= text.length ? ' ' : text[at + needle.length]!;
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** An ISO or slashed date, or a clock time: the model reckons these from today, which moves. */
const DATE_OR_TIME = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/;

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
