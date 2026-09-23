/**
 * Whether a value the executor typed was derived at run time, and by which
 * rule, so the trace must not replay it.
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
 *
 * Each rule answers with its own `DerivedReason`, so the report can say which
 * one fired and each is pinned on its own:
 *
 * - `pixels`: the model was shown a screenshot this step, whose text the
 *   tree does not list, so any value that is not literal may have been read
 *   off the image.
 * - `whole-node`: the value is the whole of what some node said (its name or
 *   its text, whitespace-normalized).
 * - `minted-token`: the value is data-shaped (one token, with a digit: a
 *   code, a count, a reference) and some node showed it as a word of its own.
 *   The digit is a glyph test standing in for provenance: "1" typed beside a
 *   "Row 1" label is flagged too, and the executor runs that part live.
 * - `date`: a date or a clock time, which the model reckons from today.
 *
 * A bare word inside a sentence is none of these: "one" typed on a page that
 * lists "Row one" is the model's own choice, and the recording replays it.
 * So is a name inside a greeting ("Jane" under "Welcome back, Jane"); when
 * that name was in fact read off the screen, the replay types last run's
 * value and self-finalizes, backstopped only when the value resurfaces in the
 * end anchors.
 */

import type { DerivedReason } from '../cache/trace.ts';
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

/**
 * The rule that makes a typed value this run's data, or undefined for a
 * value that replays: one the instruction or the params spell out, or one
 * the model composed itself.
 */
export function derivedReason(
  value: string,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
  evidence: StepEvidence = {},
): DerivedReason | undefined {
  const needle = normalize(value);
  if (needle === '' || isLiteral(needle, instruction, params)) return undefined;
  if (evidence.pixels === true) return 'pixels';
  const dataShaped = isDataShaped(needle);
  let mintedToken = false;
  for (const text of evidence.shown ?? []) {
    const shown = normalize(text);
    if (shown === needle) return 'whole-node';
    if (dataShaped && hasWord(shown, needle)) mintedToken = true;
  }
  if (mintedToken) return 'minted-token';
  return DATE_OR_TIME.test(value) ? 'date' : undefined;
}

/** Whether the instruction or a param spells the value out: the step's literal input, which replays verbatim. */
function isLiteral(needle: string, instruction: string, params: Readonly<Record<string, JsonValue>> | undefined): boolean {
  return normalize(instruction).includes(needle) || paramStrings(params).some((text) => normalize(text).includes(needle));
}

/**
 * Whether a value looks like data rather than words: one token, no
 * whitespace, with a digit in it. `TK-4972`, `123`, `n20123` qualify; `Jane`
 * and `one` do not, so those count as read off the screen only when a node
 * says exactly that and nothing more.
 */
function isDataShaped(needle: string): boolean {
  return !/\s/u.test(needle) && /\p{N}/u.test(needle);
}

/**
 * Whether the text carries the value as a whole token: "123" inside
 * "n20123" is not the screen showing it.
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
