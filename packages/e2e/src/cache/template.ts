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
 * placeholder naming the parameter, and the key digests the params' shape
 * rather than their values. At replay the placeholders are filled from the
 * current params, so the same flow replays with this run's values and the
 * end anchors still check this run's outcome. Short strings, numbers, and
 * booleans stay literal: `'2'` or `'ok'` occur everywhere on a screen, and
 * templating them would rewrite text the parameter never produced.
 *
 * Templating is fail-closed like the rest of replay: a placeholder that names
 * a parameter the current call lacks, or one whose value is not a string,
 * makes the entry unusable, which the caller reports as a miss.
 */

import type { JsonValue } from '../types.ts';
import type { ActionTrace, RecordedAction, TraceTargetDescriptor } from './trace.ts';

/** Shortest string parameter that is templated; below this a value is not distinctive. */
const MIN_TEMPLATE_CHARS = 3;

const PLACEHOLDER_OPEN = '{{param:';
const PLACEHOLDER_CLOSE = '}}';
const PLACEHOLDER = /\{\{param:([^{}]+)\}\}/gu;

/** The stand-in a templated string takes in the key, whatever its value. A NUL prefix keeps it apart from any real value. */
const SHAPE_MARKER = `${String.fromCharCode(0)}param`;

/** A parameter's place in the params object (`name`, `address.city`, `tags[0]`) and its value. */
export interface ParamTemplate {
  readonly path: string;
  readonly value: string;
}

/** Whether a string parameter is templated: long enough to be distinctive. */
function isTemplatable(value: string): boolean {
  return value.length >= MIN_TEMPLATE_CHARS;
}

/** True for the projected form of a `Secret`; its fields are a name and a purpose, never screen text. */
function isProjectedSecret(value: Readonly<Record<string, JsonValue>>): boolean {
  return value['kind'] === 'secret' && typeof value['name'] === 'string';
}

/**
 * Every templatable string parameter, longest value first so a value that
 * contains another (`"Ada Lovelace"` and `"Ada"`) is claimed whole before the
 * shorter one is looked for.
 */
export function paramTemplates(params: Readonly<Record<string, JsonValue>> | undefined): readonly ParamTemplate[] {
  const templates: ParamTemplate[] = [];
  const walk = (value: JsonValue, path: string): void => {
    if (typeof value === 'string') {
      if (isTemplatable(value)) templates.push({ path, value });
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    const object = value as Readonly<Record<string, JsonValue>>;
    if (isProjectedSecret(object)) return;
    for (const [key, item] of Object.entries(object)) walk(item, path === '' ? key : `${path}.${key}`);
  };
  for (const [key, value] of Object.entries(params ?? {})) walk(value, key);
  return templates.toSorted((a, b) => b.value.length - a.value.length || a.path.localeCompare(b.path));
}

/**
 * The params as the key sees them: every templatable string replaced by one
 * marker, everything else as given. Two calls whose params differ only in
 * such strings share a key, and therefore a recording.
 */
export function paramsShape(params: Readonly<Record<string, JsonValue>> | undefined): JsonValue {
  const shape = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return isTemplatable(value) ? SHAPE_MARKER : value;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(shape);
    const object = value as Readonly<Record<string, JsonValue>>;
    if (isProjectedSecret(object)) return object;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, shape(item)]));
  };
  return shape(params ?? {});
}

/**
 * Replaces every occurrence of each template's value in `text` with its
 * placeholder. Literal segments are tracked so a value never matches inside a
 * placeholder written a moment earlier (a parameter named `name` whose value
 * is `name`). Text that already spells a placeholder is the caller's problem:
 * `templateTrace` poisons such a trace instead of guessing.
 */
export function templateText(text: string, templates: readonly ParamTemplate[]): string {
  type Segment = { readonly literal: boolean; readonly text: string };
  let segments: Segment[] = [{ literal: true, text }];
  for (const template of templates) {
    const next: Segment[] = [];
    for (const segment of segments) {
      if (!segment.literal || !segment.text.includes(template.value)) {
        next.push(segment);
        continue;
      }
      const parts = segment.text.split(template.value);
      parts.forEach((part, index) => {
        if (part !== '') next.push({ literal: true, text: part });
        if (index < parts.length - 1) {
          next.push({ literal: false, text: `${PLACEHOLDER_OPEN}${template.path}${PLACEHOLDER_CLOSE}` });
        }
      });
    }
    segments = next;
  }
  return segments.map((segment) => segment.text).join('');
}

/** Whether `text` already contains a placeholder, recorded or literal. */
function containsPlaceholder(text: string): boolean {
  return text.includes(PLACEHOLDER_OPEN);
}

/**
 * Fills every placeholder in `text` from `params`, or returns undefined when
 * one names a parameter the call does not carry as a templatable string.
 */
export function expandText(text: string, params: Readonly<Record<string, JsonValue>> | undefined): string | undefined {
  if (!containsPlaceholder(text)) return text;
  const values = new Map(paramTemplates(params).map((template) => [template.path, template.value]));
  let missing = false;
  const expanded = text.replace(PLACEHOLDER, (_match, path: string) => {
    const value = values.get(path);
    if (value === undefined) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? undefined : expanded;
}

type StringMap = (text: string) => string | undefined;

/** The descriptor fields that carry screen text a parameter can appear in. */
const DESCRIPTOR_TEXT_FIELDS = ['name', 'text', 'placeholder', 'testId', 'within'] as const;

function mapDescriptor(descriptor: TraceTargetDescriptor, map: StringMap): TraceTargetDescriptor | undefined {
  const changes: Partial<Record<(typeof DESCRIPTOR_TEXT_FIELDS)[number], string>> = {};
  for (const field of DESCRIPTOR_TEXT_FIELDS) {
    const value = descriptor[field];
    if (value === undefined) continue;
    const mapped = map(value);
    if (mapped === undefined) return undefined;
    if (mapped !== value) changes[field] = mapped;
  }
  return Object.keys(changes).length === 0 ? descriptor : { ...descriptor, ...changes };
}

function mapAction(action: RecordedAction, map: StringMap): RecordedAction | undefined {
  const summary = map(action.summary);
  if (summary === undefined) return undefined;
  const withSummary = <A extends RecordedAction>(next: A): A => (summary === next.summary ? next : { ...next, summary });
  const target = (descriptor: TraceTargetDescriptor): TraceTargetDescriptor | undefined => mapDescriptor(descriptor, map);
  switch (action.name) {
    case 'tap':
    case 'typeSecret':
    case 'press': {
      const mapped = target(action.target);
      return mapped === undefined ? undefined : withSummary({ ...action, target: mapped });
    }
    case 'type':
    case 'select': {
      const mapped = target(action.target);
      const value = map(action.value);
      return mapped === undefined || value === undefined ? undefined : withSummary({ ...action, target: mapped, value });
    }
    case 'scroll': {
      if (action.target === undefined) return withSummary(action);
      const mapped = target(action.target);
      return mapped === undefined ? undefined : withSummary({ ...action, target: mapped });
    }
    case 'navigate': {
      const url = map(action.url);
      return url === undefined ? undefined : withSummary({ ...action, url });
    }
    case 'typeText': {
      const value = map(action.value);
      return value === undefined ? undefined : withSummary({ ...action, value });
    }
    case 'tapAt': {
      if (action.within === undefined) return withSummary(action);
      const mapped = target(action.within.target);
      return mapped === undefined ? undefined : withSummary({ ...action, within: { ...action.within, target: mapped } });
    }
    case 'pressKey':
    case 'dismissKeyboard':
    case 'tool':
      return withSummary(action);
  }
}

/** Applies `map` to every recorded string a parameter value can appear in; undefined when any mapping fails. */
function mapTrace(trace: ActionTrace, map: StringMap): ActionTrace | undefined {
  const actions: RecordedAction[] = [];
  for (const action of trace.actions) {
    const mapped = mapAction(action, map);
    if (mapped === undefined) return undefined;
    actions.push(mapped);
  }
  const summary = map(trace.summary);
  if (summary === undefined) return undefined;
  let endAnchors: TraceTargetDescriptor[] | undefined;
  if (trace.endAnchors !== undefined) {
    endAnchors = [];
    for (const anchor of trace.endAnchors) {
      const mapped = mapDescriptor(anchor, map);
      if (mapped === undefined) return undefined;
      endAnchors.push(mapped);
    }
  }
  return {
    ...trace,
    actions,
    summary,
    ...(endAnchors === undefined ? {} : { endAnchors }),
  };
}

/** The placeholder a template writes. */
function placeholderOf(path: string): string {
  return `${PLACEHOLDER_OPEN}${path}${PLACEHOLDER_CLOSE}`;
}

/**
 * The recording as stored: parameter values replaced by placeholders. A
 * templatable value the recorded text never contained gets no placeholder,
 * yet may have steered the flow (a plan name the model turned into a tap on
 * another label), so it is kept in `literalParams` and a replay requires it
 * unchanged. Text that already spelled a placeholder cannot be told from a
 * recorded one, so such a trace is marked non-replayable rather than expanded
 * wrongly later.
 */
export function templateTrace(trace: ActionTrace, params: Readonly<Record<string, JsonValue>> | undefined): ActionTrace {
  const templates = paramTemplates(params);
  let poisoned = false;
  const mapped =
    mapTrace(trace, (text) => {
      if (containsPlaceholder(text)) poisoned = true;
      return templateText(text, templates);
    }) ?? trace;
  const bound = new Set<string>();
  mapTrace(mapped, (text) => {
    for (const template of templates) if (text.includes(placeholderOf(template.path))) bound.add(template.path);
    return text;
  });
  const literalParams = Object.fromEntries(
    templates.filter((template) => !bound.has(template.path)).map((template) => [template.path, template.value]),
  );
  return {
    ...mapped,
    ...(Object.keys(literalParams).length === 0 ? {} : { literalParams }),
    ...(poisoned ? { truncated: true } : {}),
  };
}

/**
 * The recording as replayed: placeholders filled from this call's params, or
 * undefined when the entry names a parameter this call does not carry, or a
 * literal param's value differs from the one recorded.
 */
export function expandTrace(trace: ActionTrace, params: Readonly<Record<string, JsonValue>> | undefined): ActionTrace | undefined {
  const values = new Map(paramTemplates(params).map((template) => [template.path, template.value]));
  for (const [path, literal] of Object.entries(trace.literalParams ?? {})) {
    if (values.get(path) !== literal) return undefined;
  }
  return mapTrace(trace, (text) => expandText(text, params));
}
