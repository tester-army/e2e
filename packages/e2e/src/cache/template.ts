/**
 * Parameter templating for recorded traces.
 *
 * A goal like `act('create a company named {name}', { params: { name } })`
 * usually carries a run-unique value — a timestamped name, a fresh email —
 * so that the record it makes never collides with the last run's. Recorded
 * verbatim, such a value would defeat the cache twice over: the key would
 * change with the value, and the recorded inputs and target descriptors
 * ("tap option 'E2E 4f3 Company'") would never re-find their nodes.
 *
 * So the recording is a template. Every string parameter long enough to be
 * distinctive is replaced, wherever it appears in recorded text, by a
 * placeholder naming the parameter, and the key digests the params with
 * those strings removed plus the list of their paths. At replay the
 * placeholders are filled from the current params, so the same flow replays
 * with this run's values and the end anchors still check this run's outcome.
 * Short strings, numbers, and booleans stay literal: `'2'` or `'ok'` occur
 * everywhere on a screen, and templating them would rewrite text the
 * parameter never produced.
 *
 * Templating is fail-closed like the rest of replay: a placeholder that names
 * a parameter the current call lacks, a pinned parameter whose value changed,
 * or text that already spelled a placeholder makes the entry unusable, which
 * the caller reports as a miss.
 */

import { isProjectedSecret } from '../agent/act-validation.ts';
import type { JsonValue } from '../types.ts';
import { mapTraceText, type ActionTrace } from './trace.ts';

/** Shortest string parameter that is templated; below this a value is not distinctive. */
const MIN_TEMPLATE_CHARS = 3;

/**
 * Placeholder grammar: `{{param:<pointer>}}`, where the pointer is the
 * parameter's JSON Pointer (RFC 6901: `/name`, `/address/city`, `/tags/0`,
 * with `~` and `/` in a key escaped as `~0` and `~1`). One codec owns both
 * directions; a pointer never contains `}`, so the closing brace is unambiguous.
 */
const PLACEHOLDER = /\{\{param:([^}]*)\}\}/gu;

function encodePlaceholder(pointer: string): string {
  return `{{param:${pointer}}}`;
}

function pointerSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** `Array.isArray` does not narrow a readonly array away; this does. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** A parameter's JSON Pointer and its value. */
export interface ParamTemplate {
  readonly pointer: string;
  readonly value: string;
}

function isTemplatable(value: string): boolean {
  return value.length >= MIN_TEMPLATE_CHARS && !value.includes('}');
}

/**
 * Walks the projected params once, handing every templatable string to `f`
 * with its pointer and keeping everything else — numbers, booleans, short
 * strings, and secret placeholders (a name and a purpose, never screen text).
 */
function mapParamStrings(
  params: Readonly<Record<string, JsonValue>> | undefined,
  f: (pointer: string, value: string) => JsonValue,
): Readonly<Record<string, JsonValue>> {
  const walk = (value: JsonValue, pointer: string): JsonValue => {
    if (typeof value === 'string') return isTemplatable(value) ? f(pointer, value) : value;
    if (value === null || typeof value !== 'object') return value;
    if (isJsonArray(value)) return value.map((item, index) => walk(item, `${pointer}/${index}`));
    if (isProjectedSecret(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, `${pointer}/${pointerSegment(key)}`)]));
  };
  return walk(params ?? {}, '') as Readonly<Record<string, JsonValue>>;
}

/**
 * Every templatable string parameter, longest value first so a value that
 * contains another (`"Ada Lovelace"` and `"Ada"`) is claimed whole before the
 * shorter one is looked for; equal lengths order by pointer, so the order is
 * stable.
 */
export function paramTemplates(params: Readonly<Record<string, JsonValue>> | undefined): readonly ParamTemplate[] {
  const templates: ParamTemplate[] = [];
  mapParamStrings(params, (pointer, value) => {
    templates.push({ pointer, value });
    return value;
  });
  return templates.toSorted((a, b) => b.value.length - a.value.length || a.pointer.localeCompare(b.pointer));
}

/**
 * The params as the key sees them: the literal values with every templatable
 * string removed, and the pointers of the strings that were. Two calls whose
 * params differ only in such strings share a key, and therefore a recording.
 */
export function paramsShape(params: Readonly<Record<string, JsonValue>> | undefined): JsonValue {
  const templated: string[] = [];
  const literal = mapParamStrings(params, (pointer) => {
    templated.push(pointer);
    return null;
  });
  return { literal, templated: templated.toSorted() };
}

/**
 * Replaces every occurrence of each template's value in `text` with its
 * placeholder, noting each pointer it wrote into `bound`. Literal segments
 * are tracked so a value never matches inside a placeholder written a moment
 * earlier (a parameter named `name` whose value is `name`).
 */
export function templateText(text: string, templates: readonly ParamTemplate[], bound?: Set<string>): string {
  type Segment = { readonly literal: boolean; readonly text: string };
  let segments: Segment[] = [{ literal: true, text }];
  for (const template of templates) {
    const next: Segment[] = [];
    for (const segment of segments) {
      if (!segment.literal || !segment.text.includes(template.value)) {
        next.push(segment);
        continue;
      }
      bound?.add(template.pointer);
      const parts = segment.text.split(template.value);
      parts.forEach((part, index) => {
        if (part !== '') next.push({ literal: true, text: part });
        if (index < parts.length - 1) next.push({ literal: false, text: encodePlaceholder(template.pointer) });
      });
    }
    segments = next;
  }
  return segments.map((segment) => segment.text).join('');
}

/**
 * Fills every placeholder in `text` from `values` (pointer to value), or
 * returns undefined when one names a parameter the call does not carry as a
 * templatable string.
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
 * The recording as stored: parameter values replaced by placeholders, or
 * undefined when the recorded text already spelled a placeholder, which
 * could not be told from a recorded one at replay.
 *
 * A templatable value the recorded text never contained gets no placeholder,
 * yet may have steered the flow (a plan name the model turned into a tap on
 * another label), so it is pinned in `literalParams` and a replay requires it
 * unchanged. Two calls alternating such a value therefore take turns missing
 * and re-recording the one entry their shared key names; the cache does not
 * keep a variant per value.
 */
export function templateTrace(trace: ActionTrace, params: Readonly<Record<string, JsonValue>> | undefined): ActionTrace | undefined {
  const templates = paramTemplates(params);
  const bound = new Set<string>();
  let literalPlaceholder = false;
  const templated = mapTraceText(trace, (text) => {
    if (text.includes('{{param:')) literalPlaceholder = true;
    return templateText(text, templates, bound);
  });
  if (templated === undefined || literalPlaceholder) return undefined;
  const literalParams = Object.fromEntries(
    templates.filter((template) => !bound.has(template.pointer)).map((template) => [template.pointer, template.value]),
  );
  return Object.keys(literalParams).length === 0 ? templated : { ...templated, literalParams };
}

/**
 * The recording as replayed: placeholders filled from this call's params, or
 * undefined when the entry names a parameter this call does not carry, or a
 * pinned parameter's value differs from the one recorded.
 */
export function expandTrace(trace: ActionTrace, params: Readonly<Record<string, JsonValue>> | undefined): ActionTrace | undefined {
  const values = new Map(paramTemplates(params).map((template) => [template.pointer, template.value]));
  for (const [pointer, literal] of Object.entries(trace.literalParams ?? {})) {
    if (values.get(pointer) !== literal) return undefined;
  }
  return mapTraceText(trace, (text) => expandText(text, values));
}
