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
 * Placeholder grammar: `{{param:<pointer>}}` for the value as given and
 * `{{param:<pointer>|<encoding>}}` for the value as a URL spells it, closed
 * by the first `}}`. One codec owns both directions.
 *
 * A value typed into a search box comes back in the address bar as
 * `?search=E2E+abc` or `/companies/E2E%20abc`; a recorded path that kept
 * either form literal would never match the next run's path. So each value
 * is looked for in its encoded forms too, and the placeholder says which
 * encoding to apply when it is filled.
 */
const PLACEHOLDER_PREFIX = '{{param:';
const PLACEHOLDER = /\{\{param:(.*?)\}\}/gu;

/**
 * How a value may be spelled in recorded text: as given, percent-encoded,
 * form-encoded with `+` for spaces, or as the slug an app derives for a
 * record's path (`/companies/e2e-abc-company`).
 */
type Encoding = 'uri' | 'form' | 'slug';

const ENCODERS: Readonly<Record<Encoding, (value: string) => string>> = {
  uri: (value) => encodeURIComponent(value),
  // What a form submission or `URLSearchParams` writes: `+` for a space, and
  // `!'()~` percent-encoded too, which `encodeURIComponent` leaves alone.
  form: (value) => new URLSearchParams([['v', value]]).toString().slice(2),
  // Lowercase, letters and digits kept, every other run as one dash.
  slug: (value) =>
    value
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
      .replaceAll(/^-+|-+$/g, ''),
};

/** A value's encoded spelling, or undefined when it has none (an unpaired surrogate cannot be encoded). */
function encode(encoding: Encoding, value: string): string | undefined {
  try {
    return ENCODERS[encoding](value);
  } catch {
    return undefined;
  }
}

function placeholder(pointer: string, encoding?: Encoding): string {
  return `${PLACEHOLDER_PREFIX}${pointer}${encoding === undefined ? '' : `|${encoding}`}}}`;
}

/** The pointer and encoding a placeholder names; undefined for an encoding this codec does not know. */
function parsePlaceholder(inner: string): { readonly pointer: string; readonly encoding: Encoding | undefined } | undefined {
  const bar = inner.lastIndexOf('|');
  if (bar === -1) return { pointer: inner, encoding: undefined };
  const encoding = inner.slice(bar + 1);
  return encoding in ENCODERS ? { pointer: inner.slice(0, bar), encoding: encoding as Encoding } : undefined;
}

/** One spelling of a template's value and the placeholder that stands for it. */
interface Spelling {
  readonly text: string;
  readonly placeholder: string;
  readonly pointer: string;
}

/** Every distinct spelling of every template, longest text first so a longer value, or a longer encoding of one, is claimed whole. */
function spellings(templates: readonly ParamTemplate[]): readonly Spelling[] {
  const out: Spelling[] = [];
  for (const template of templates) {
    const seen = new Set<string>([template.value]);
    out.push({ text: template.value, placeholder: placeholder(template.pointer), pointer: template.pointer });
    for (const encoding of Object.keys(ENCODERS) as Encoding[]) {
      const text = encode(encoding, template.value);
      if (text === undefined || text === '' || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, placeholder: placeholder(template.pointer, encoding), pointer: template.pointer });
    }
  }
  return out.toSorted((a, b) => b.text.length - a.text.length || a.pointer.localeCompare(b.pointer) || a.placeholder.localeCompare(b.placeholder));
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
 * Whether no two templates share a spelling: two marked params with one
 * value, or one whose value is another's encoded form (`a b` and `a%20b`),
 * would leave the text unable to say which param it spelled.
 */
function spellingsDistinct(templates: readonly ParamTemplate[]): boolean {
  const owners = new Map<string, string>();
  for (const spelling of spellings(templates)) {
    const owner = owners.get(spelling.text);
    if (owner !== undefined && owner !== spelling.pointer) return false;
    owners.set(spelling.text, spelling.pointer);
  }
  return true;
}

/**
 * Replaces every occurrence of each template's value in `text`, in any of
 * its spellings, with the matching placeholder. Longer texts are claimed
 * first, so a value that contains another (`"Ada Lovelace"` and `"Ada"`) is
 * replaced whole; equal lengths order by pointer, so the result is stable.
 * Literal segments are tracked so a value never matches inside a placeholder
 * written a moment earlier (a parameter named `name` whose value is `name`).
 */
export function templateText(text: string, templates: readonly ParamTemplate[]): string {
  type Segment = { readonly literal: boolean; readonly text: string };
  let segments: Segment[] = [{ literal: true, text }];
  for (const spelling of spellings(templates)) {
    const next: Segment[] = [];
    for (const segment of segments) {
      if (!segment.literal || !segment.text.includes(spelling.text)) {
        next.push(segment);
        continue;
      }
      const parts = segment.text.split(spelling.text);
      parts.forEach((part, index) => {
        if (part !== '') next.push({ literal: true, text: part });
        if (index < parts.length - 1) next.push({ literal: false, text: spelling.placeholder });
      });
    }
    segments = next;
  }
  return segments.map((segment) => segment.text).join('');
}

/**
 * Fills every placeholder in `text` from `values` (pointer to value), in the
 * encoding the placeholder names, or returns undefined when one names a
 * parameter the call did not mark or an encoding this codec does not know.
 */
export function expandText(text: string, values: ReadonlyMap<string, string>): string | undefined {
  let missing = false;
  const expanded = text.replace(PLACEHOLDER, (_match, inner: string) => {
    const parsed = parsePlaceholder(inner);
    const value = parsed === undefined ? undefined : values.get(parsed.pointer);
    if (parsed === undefined || value === undefined) {
      missing = true;
      return '';
    }
    const filled = parsed.encoding === undefined ? value : encode(parsed.encoding, value);
    if (filled === undefined) {
      missing = true;
      return '';
    }
    return filled;
  });
  return missing ? undefined : expanded;
}

/**
 * The recording as stored: each template's value replaced by its placeholder
 * wherever the recorded text spelled it, or undefined when the recording
 * cannot be templated safely: the text already spelled a placeholder, which
 * could not be told from a written one at replay, or two marked params
 * share a spelling, so the text cannot say which one it came from.
 */
export function templateTrace(trace: ActionTrace, templates: readonly ParamTemplate[]): ActionTrace | undefined {
  if (!spellingsDistinct(templates)) return undefined;
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
