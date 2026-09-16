/**
 * Whether a typed value is the step's own data or data it derived at run
 * time.
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

export function isDerivedValue(
  value: string,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
  screens: readonly string[] = [],
): boolean {
  const needle = normalize(value);
  if (needle === '') return false;
  if (normalize(instruction).includes(needle)) return false;
  if (paramStrings(params).some((text) => normalize(text).includes(needle))) return false;
  // Read off the screen (a code, a reference, a name the app minted) or
  // reckoned from the calendar: this run's data. Anything else the model
  // composed itself, and the next run's app takes it as readily.
  if (screens.some((text) => hasWord(normalize(withoutInputValues(text)), needle))) return true;
  return DATE_OR_TIME.test(value);
}

/**
 * Whether the screen text carries the value as a whole token: "123" inside
 * a node id "#n20123" or "Jane" inside "Janet" is not the screen showing it.
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

const INPUT_LINE = /^\s*#\S+ (?:textbox|searchbox|combobox|spinbutton)\b/;

/**
 * A screen's text without the lines of editable fields and the wrappers
 * that name them: a field shows the value typed into it and, before that,
 * its placeholder example, and some platforms repeat both on the container
 * node above it. Either would make a composed value look screen-derived.
 */
function withoutInputValues(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (INPUT_LINE.test(line)) continue;
    const next = lines[index + 1] ?? '';
    if (INPUT_LINE.test(next) && indentOf(next) > indentOf(line)) continue;
    // The node id is the runner's handle, not something the screen shows.
    kept.push(line.replace(/^\s*#\S+\s?/, ''));
  }
  return kept.join('\n');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
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
