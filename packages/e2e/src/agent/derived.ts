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

/** What the step showed the model, which a typed value may have been read off. */
export interface StepEvidence {
  /**
   * What the screens displayed, one string per node
   * (`ObservationFeed.shownText`): the fields that echo a typed value are
   * already left out of it.
   */
  readonly shown?: Iterable<string>;
  /**
   * Whether the model received a screenshot in this step. Text drawn in
   * pixels is not in `shown`, so a value that is not literal may have been
   * read off the image and counts as derived.
   */
  readonly pixels?: boolean;
}

export function isDerivedValue(
  value: string,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
  evidence: StepEvidence = {},
): boolean {
  const needle = normalize(value);
  if (needle === '') return false;
  if (normalize(instruction).includes(needle)) return false;
  if (paramStrings(params).some((text) => normalize(text).includes(needle))) return false;
  if (evidence.pixels === true) return true;
  // Read off the screen (a code, a reference, a name the app minted) or
  // reckoned from the calendar: this run's data. Anything else the model
  // composed itself, and the next run's app takes it as readily.
  for (const text of evidence.shown ?? []) {
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

/** A month by name or abbreviation, with or without a trailing period. */
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;

/**
 * A date in ISO, numeric, or month-name form, or a clock time: the model
 * reckons these from today, which moves.
 */
const DATE_OR_TIME = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b`,
    String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
    String.raw`\b${MONTH} ${DAY}(?:,? \d{4})?\b`,
    String.raw`\b${DAY} ${MONTH}(?:,? \d{4})?\b`,
  ].join('|'),
  'i',
);

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
