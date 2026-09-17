/**
 * Slots for `unique()` values in recorded traces.
 *
 * A goal like `act('create a company named {name}', { params: { name } })`
 * usually carries a run-unique value — a timestamped name, a fresh email —
 * so that the record it makes never collides with the last run's. Recorded
 * verbatim, such a value would defeat the cache twice over: the key would
 * change with the value, and the recorded inputs and target descriptors
 * ("tap option 'E2E 4f3 Company'") would never re-find their nodes.
 *
 * So a value the test marked with `unique()` is a slot. The key digests the
 * params with a placeholder naming the parameter where the value was, the
 * recording carries the same placeholder wherever the value appeared in its
 * text, and at replay the placeholders are filled from the current call, so
 * the same flow replays with this run's values and the end anchors check
 * this run's outcome. Everything not marked is literal, in the key and in
 * the recording alike.
 *
 * Templating is fail-closed like the rest of replay: a placeholder that names
 * a parameter the current call did not mark, or recorded text that already
 * spelled a placeholder, makes the entry unusable, which the caller reports
 * as a miss.
 */

import type { JsonValue } from '../types.ts';
import { mapTraceText, type ActionTrace } from './trace.ts';

/** One `unique()` param: its JSON Pointer in the params and this call's value. */
export interface ParamTemplate {
  readonly pointer: string;
  readonly value: string;
}

/** Extends a JSON Pointer (RFC 6901) by one key; `~` and `/` in a key become `~0` and `~1`. */
export function paramPointer(parent: string, key: string | number): string {
  return `${parent}/${typeof key === 'number' ? key : key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/**
 * Placeholder grammar: `{{param:<pointer>}}`. A pointer never contains `}`,
 * so the closing braces are unambiguous; one codec owns both directions.
 */
const PLACEHOLDER_PREFIX = '{{param:';
const PLACEHOLDER = /\{\{param:([^}]*)\}\}/gu;

function placeholder(pointer: string): string {
  return `${PLACEHOLDER_PREFIX}${pointer}}}`;
}

/** `Array.isArray` does not narrow a readonly array away; this does. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * The params as the key digests them: each template's leaf replaced by its
 * placeholder. Two calls whose params differ only in `unique()` values share
 * a key, and therefore a recording. A missing params object is the empty
 * object, so `act(x)` and `act(x, {})` share one entry.
 */
export function templateParams(
  params: Readonly<Record<string, JsonValue>> | undefined,
  templates: readonly ParamTemplate[],
): Readonly<Record<string, JsonValue>> {
  const pointers = new Set(templates.map((template) => template.pointer));
  const walk = (value: JsonValue, pointer: string): JsonValue => {
    if (pointers.has(pointer)) return placeholder(pointer);
    if (value === null || typeof value !== 'object') return value;
    if (isJsonArray(value)) return value.map((item, index) => walk(item, paramPointer(pointer, index)));
    return walkObject(value, pointer);
  };
  const walkObject = (value: Readonly<Record<string, JsonValue>>, pointer: string): Readonly<Record<string, JsonValue>> =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, paramPointer(pointer, key))]));
  return walkObject(params ?? {}, '');
}

/**
 * Replaces every occurrence of each template's value in `text` with its
 * placeholder. Longer values are claimed first, so a value that contains
 * another (`"Ada Lovelace"` and `"Ada"`) is replaced whole; equal lengths
 * order by pointer, so the result is stable. Literal segments are tracked so
 * a value never matches inside a placeholder written a moment earlier (a
 * parameter named `name` whose value is `name`).
 */
export function templateText(text: string, templates: readonly ParamTemplate[]): string {
  type Segment = { readonly literal: boolean; readonly text: string };
  const byLength = templates.toSorted((a, b) => b.value.length - a.value.length || a.pointer.localeCompare(b.pointer));
  let segments: Segment[] = [{ literal: true, text }];
  for (const template of byLength) {
    const next: Segment[] = [];
    for (const segment of segments) {
      if (!segment.literal || !segment.text.includes(template.value)) {
        next.push(segment);
        continue;
      }
      const parts = segment.text.split(template.value);
      parts.forEach((part, index) => {
        if (part !== '') next.push({ literal: true, text: part });
        if (index < parts.length - 1) next.push({ literal: false, text: placeholder(template.pointer) });
      });
    }
    segments = next;
  }
  return segments.map((segment) => segment.text).join('');
}

/**
 * Fills every placeholder in `text` from `values` (pointer to value), or
 * returns undefined when one names a parameter the call did not mark.
 */
export function expandText(text: string, values: ReadonlyMap<string, string>): string | undefined {
  let missing = false;
  const expanded = text.replace(PLACEHOLDER, (_match, pointer: string) => {
    const value = values.get(pointer);
    if (value === undefined) missing = true;
    return value ?? '';
  });
  return missing ? undefined : expanded;
}

/**
 * The recording as stored: each template's value replaced by its placeholder
 * wherever the recorded text spelled it, or undefined when the text already
 * spelled a placeholder, which could not be told from a written one at replay.
 */
export function templateTrace(trace: ActionTrace, templates: readonly ParamTemplate[]): ActionTrace | undefined {
  let literalPlaceholder = false;
  const templated = mapTraceText(trace, (text) => {
    if (text.includes(PLACEHOLDER_PREFIX)) literalPlaceholder = true;
    return templateText(text, templates);
  });
  return literalPlaceholder ? undefined : templated;
}

/**
 * The recording as replayed: placeholders filled from this call's templates,
 * or undefined when the entry names a parameter this call did not mark.
 */
export function expandTrace(trace: ActionTrace, templates: readonly ParamTemplate[]): ActionTrace | undefined {
  const values = new Map(templates.map((template) => [template.pointer, template.value]));
  return mapTraceText(trace, (text) => expandText(text, values));
}
