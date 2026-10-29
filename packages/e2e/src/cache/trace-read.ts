/**
 * Reading a stored `trace-1` entry back into the types `trace.ts` declares.
 *
 * Every field is validated on the way in, and unknown fields are dropped:
 * a document that reads back as an entry replays verbatim, and one this
 * runner cannot trust or replay comes back as `undefined`, never as a
 * repaired or partially trusted entry.
 */

import { isKeyModifier, KEY_MODIFIERS, type KeyModifier } from '../engine/contract.ts';
import type { ScrollDirection } from '../types.ts';
import { readBoundedText, readRecordedModel } from './trace-fields.ts';
import {
  DESCRIPTOR_FIELDS,
  each,
  isNodeActionName,
  isTapActionName,
  KEY_CONTEXT_FIELDS,
  MAX_TRACE_ACTIONS,
  MAX_TRACE_ANCHORS,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_END_WAIT_MS,
  MAX_TRACE_INPUT_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  MAX_TRACE_UPLOAD_PATHS,
  oneOf,
  TRACE_ANCHOR_STATES,
  TRACE_SCHEMA_VERSION,
  type ActionTrace,
  type DerivedReason,
  type RecordedAction,
  type TraceAnchorState,
  type TraceEntry,
  type TraceKeyContext,
  type TracePointEnd,
  type TracePosition,
  type TraceProvenance,
  type TraceTargetDescriptor,
  type TraceViewport,
} from './trace.ts';

/** The shape of a SHA-256 digest in hex, as `instructionDigest` writes it. */
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** Most twins a positional recording distinguishes between; beyond it a list is data, not a control set. */
const MAX_TRACE_POSITION_OF = 1000;

const isScrollDirection = oneOf(['up', 'down', 'left', 'right'] as const satisfies readonly ScrollDirection[]);

const isTraceAnchorState = oneOf(TRACE_ANCHOR_STATES);

const isDerivedReason = oneOf(['pixels', 'whole-node', 'minted-token', 'date'] as const satisfies readonly DerivedReason[]);

/** A stored `keyedBy`, or undefined for anything else; a malformed one is dropped, never failing the entry. */
function readKeyContext(document: unknown): TraceKeyContext | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const raw = document as Record<string, unknown>;
  const read: Record<string, string | number> = {};
  for (const field of KEY_CONTEXT_FIELDS) {
    const value: string | number | undefined =
      field === 'engineSpiVersion'
        ? typeof raw[field] === 'number' && Number.isSafeInteger(raw[field]) ? raw[field] : undefined
        : readBoundedText(raw[field], MAX_TRACE_DESCRIPTOR_CHARS);
    if (value === undefined) return undefined;
    read[field] = value;
  }
  return read as TraceKeyContext;
}

/** The shape `timestamp()` writes: an ISO 8601 UTC instant. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Reads one document as a `trace-1` entry, or returns undefined when it is
 * not one this runner can trust. Unknown fields are dropped rather than
 * carried: the returned entry contains exactly the validated shape.
 */
export function readTraceEntry(document: unknown): TraceEntry | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  if (raw['schemaVersion'] !== TRACE_SCHEMA_VERSION) return undefined;
  // Provenance must be the ISO instant this runner writes (`timestamp()`),
  // not synthesized and not merely something Date.parse tolerates: a custom
  // store returning anything else is returning a document this runner never
  // wrote, and fail-to-miss is the only safe answer.
  const createdAt = raw['createdAt'];
  if (typeof createdAt !== 'string' || !ISO_INSTANT.test(createdAt)) return undefined;
  const payload = readActionTrace(raw['payload']);
  if (payload === undefined) return undefined;
  return { schemaVersion: TRACE_SCHEMA_VERSION, createdAt, payload };
}

function readActionTrace(document: unknown): ActionTrace | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;

  const executorRaw = raw['executor'];
  if (typeof executorRaw !== 'object' || executorRaw === null) return undefined;
  const executorName = (executorRaw as Record<string, unknown>)['name'];
  const executorVersion = (executorRaw as Record<string, unknown>)['version'];
  if (typeof executorName !== 'string' || executorName === '') return undefined;
  if (executorVersion !== undefined && typeof executorVersion !== 'string') return undefined;

  const recordedForRaw = raw['recordedFor'];
  const recordedFor = recordedForRaw === undefined ? undefined : readProvenance(recordedForRaw);
  if (recordedForRaw !== undefined && recordedFor === undefined) return undefined;

  const recordedBy = readRecordedModel(raw['recordedBy'], MAX_TRACE_DESCRIPTOR_CHARS);

  const summary = readBoundedText(raw['summary'], MAX_TRACE_SUMMARY_CHARS);
  if (summary === undefined) return undefined;

  // A location is a replay precondition, kept whole like a typed value.
  const startPath = raw['startPath'] === undefined ? undefined : readInputText(raw['startPath']);
  if (raw['startPath'] !== undefined && startPath === undefined) return undefined;
  const endPath = raw['endPath'] === undefined ? undefined : readInputText(raw['endPath']);
  if (raw['endPath'] !== undefined && endPath === undefined) return undefined;
  const truncated = raw['truncated'];
  if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;

  const endWaitMs = raw['endWaitMs'];
  if (
    endWaitMs !== undefined &&
    (typeof endWaitMs !== 'number' || !Number.isInteger(endWaitMs) || endWaitMs < 0 || endWaitMs > MAX_TRACE_END_WAIT_MS)
  ) {
    return undefined;
  }
  const endAnchors = readAnchors(raw['endAnchors']);
  if (endAnchors === undefined) return undefined;
  const goneAnchors = readAnchors(raw['goneAnchors']);
  if (goneAnchors === undefined) return undefined;

  const actionsRaw = raw['actions'];
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0 || actionsRaw.length > MAX_TRACE_ACTIONS) {
    return undefined;
  }
  const actions = each(actionsRaw, readRecordedAction);
  if (actions === undefined) return undefined;
  const keyedBy = readKeyContext(raw['keyedBy']);

  return {
    actions,
    executor: {
      name: executorName,
      ...(executorVersion === undefined ? {} : { version: executorVersion }),
    },
    ...(recordedFor === undefined ? {} : { recordedFor }),
    ...(recordedBy === undefined ? {} : { recordedBy }),
    summary,
    ...(startPath === undefined ? {} : { startPath }),
    ...(endPath === undefined ? {} : { endPath }),
    ...(endAnchors.length === 0 ? {} : { endAnchors }),
    ...(goneAnchors.length === 0 ? {} : { goneAnchors }),
    ...(endWaitMs === undefined ? {} : { endWaitMs }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(keyedBy === undefined ? {} : { keyedBy }),
  };
}

/** One side of the recorded delta: absent reads as empty, anything malformed or over the cap as undefined. */
function readAnchors(document: unknown): TraceTargetDescriptor[] | undefined {
  if (document === undefined) return [];
  if (!Array.isArray(document) || document.length > MAX_TRACE_ANCHORS) return undefined;
  return each(document, readDescriptor);
}

/** The `modifiers` of a recorded tap-family action: a non-empty list of distinct key modifiers, or undefined when malformed. */
function readModifiers(document: unknown): readonly KeyModifier[] | undefined {
  if (!Array.isArray(document) || document.length === 0 || document.length > KEY_MODIFIERS.length) return undefined;
  const modifiers: KeyModifier[] = [];
  for (const value of document) {
    if (!isKeyModifier(value) || modifiers.includes(value)) return undefined;
    modifiers.push(value);
  }
  return modifiers;
}

function readRecordedAction(document: unknown): RecordedAction | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const summary = readBoundedText(raw['summary'], MAX_TRACE_SUMMARY_CHARS);
  if (summary === undefined) return undefined;

  const name = raw['name'];
  if (isNodeActionName(name)) {
    const target = readDescriptor(raw['target']);
    if (target === undefined) return undefined;
    if (raw['modifiers'] === undefined) return { name, summary, target };
    const modifiers = isTapActionName(name) ? readModifiers(raw['modifiers']) : undefined;
    return modifiers === undefined ? undefined : { name, summary, target, modifiers };
  }
  switch (name) {
    case 'type': {
      const target = readDescriptor(raw['target']);
      const value = readTypedValue(raw['value']);
      if (target === undefined || value === undefined) return undefined;
      return { name: 'type', summary, target, value };
    }
    case 'typeSecret': {
      const target = readDescriptor(raw['target']);
      const secret = readBoundedText(raw['secret'], MAX_TRACE_DESCRIPTOR_CHARS);
      if (target === undefined || secret === undefined) return undefined;
      return { name: 'typeSecret', summary, target, secret };
    }
    case 'press': {
      const target = readDescriptor(raw['target']);
      const key = readBoundedText(raw['key'], 64);
      if (target === undefined || key === undefined) return undefined;
      return { name: 'press', summary, target, key };
    }
    case 'select': {
      const target = readDescriptor(raw['target']);
      const value = readInputText(raw['value']);
      if (target === undefined || value === undefined) return undefined;
      return { name: 'select', summary, target, value };
    }
    case 'check': {
      const target = readDescriptor(raw['target']);
      const checked = raw['checked'];
      if (target === undefined || typeof checked !== 'boolean') return undefined;
      return { name: 'check', summary, target, checked };
    }
    case 'upload': {
      const target = readDescriptor(raw['target']);
      const paths = readInputPaths(raw['paths']);
      if (target === undefined || paths === undefined) return undefined;
      return { name: 'upload', summary, target, paths };
    }
    case 'drag': {
      const target = readDescriptor(raw['target']);
      const destination = readDescriptor(raw['destination']);
      if (target === undefined || destination === undefined) return undefined;
      return { name: 'drag', summary, target, destination };
    }
    case 'scroll': {
      const direction = raw['direction'];
      if (!isScrollDirection(direction)) return undefined;
      const target = raw['target'] === undefined ? undefined : readDescriptor(raw['target']);
      if (raw['target'] !== undefined && target === undefined) return undefined;
      const times = raw['times'];
      if (times !== undefined && (typeof times !== 'number' || !Number.isInteger(times) || times < 2)) return undefined;
      const spans = raw['spans'];
      if (spans !== undefined && (typeof spans !== 'number' || !(spans >= 0 && spans <= 1))) return undefined;
      return {
        name: 'scroll',
        summary,
        direction,
        ...(target === undefined ? {} : { target }),
        ...(times === undefined ? {} : { times }),
        ...(spans === undefined ? {} : { spans }),
      };
    }
    case 'scrollUntil': {
      const text = readInputText(raw['text']);
      const direction = raw['direction'];
      if (text === undefined || !isScrollDirection(direction)) return undefined;
      const target = raw['target'] === undefined ? undefined : readDescriptor(raw['target']);
      if (raw['target'] !== undefined && target === undefined) return undefined;
      const spans = raw['spans'];
      if (spans !== undefined && (typeof spans !== 'number' || !(spans >= 0 && spans <= 1))) return undefined;
      return {
        name: 'scrollUntil',
        summary,
        text,
        direction,
        ...(target === undefined ? {} : { target }),
        ...(spans === undefined ? {} : { spans }),
      };
    }
    case 'navigate': {
      const url = readInputText(raw['url']);
      return url === undefined ? undefined : { name: 'navigate', summary, url };
    }
    case 'tapAt':
    case 'hoverAt': {
      const end = readPointEnd(raw);
      const viewport = readViewport(raw['viewport']);
      if (end === undefined || viewport === undefined) return undefined;
      return { name, summary, point: end.point, viewport, ...(end.within === undefined ? {} : { within: end.within }) };
    }
    case 'dragAt': {
      const from = readPointEnd(raw['from']);
      const to = readPointEnd(raw['to']);
      const viewport = readViewport(raw['viewport']);
      if (from === undefined || to === undefined || viewport === undefined) return undefined;
      return { name: 'dragAt', summary, from, to, viewport };
    }
    case 'back':
      return { name: 'back', summary };
    case 'typeText': {
      const value = readTypedValue(raw['value']);
      if (value === undefined || typeof raw['replace'] !== 'boolean') return undefined;
      return { name: 'typeText', summary, value, replace: raw['replace'] };
    }
    case 'pressKey': {
      const key = readBoundedText(raw['key'], 64);
      return key === undefined ? undefined : { name: 'pressKey', summary, key };
    }
    case 'dismissKeyboard':
      return { name: 'dismissKeyboard', summary };
    case 'tool': {
      const derived = raw['derived'];
      if (derived !== undefined && !isDerivedReason(derived)) return undefined;
      return { name: 'tool', summary, ...(derived === undefined ? {} : { derived }) };
    }
    default:
      return undefined;
  }
}

/** A point and its place inside a listed node: a point action's own fields, or one end of a drag. */
function readPointEnd(document: unknown): TracePointEnd | undefined {
  const raw = readObject(document);
  const point = readObject(raw?.['point']);
  const x = point?.['x'];
  const y = point?.['y'];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (raw?.['within'] === undefined) return { point: { x, y } };
  const within = readObject(raw['within']);
  const target = within === undefined ? undefined : readDescriptor(within['target']);
  const fx = within?.['fx'];
  const fy = within?.['fy'];
  if (target === undefined || !isFraction(fx) || !isFraction(fy)) return undefined;
  return { point: { x, y }, within: { target, fx, fy } };
}

function readViewport(document: unknown): TraceViewport | undefined {
  const raw = readObject(document);
  const width = raw?.['width'];
  const height = raw?.['height'];
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) {
    return undefined;
  }
  return { width: width as number, height: height as number };
}

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function readObject(document: unknown): Record<string, unknown> | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  return document as Record<string, unknown>;
}

function readDescriptor(document: unknown): TraceTargetDescriptor | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const descriptor: Record<string, string | TracePosition | readonly TraceAnchorState[]> = {};
  for (const field of DESCRIPTOR_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_TRACE_DESCRIPTOR_CHARS) return undefined;
    if (value !== '') descriptor[field] = value;
  }
  if (Object.keys(descriptor).length === 0) return undefined;
  if (raw['position'] !== undefined) {
    const position = readPosition(raw['position']);
    if (position === undefined) return undefined;
    descriptor['position'] = position;
  }
  if (raw['states'] !== undefined) {
    const states = readStates(raw['states']);
    if (states === undefined) return undefined;
    descriptor['states'] = states;
  }
  return descriptor as TraceTargetDescriptor;
}

/** Known anchor states, each once, in sorted order, as `anchors.ts` writes them; an empty list is never written. */
function readStates(document: unknown): readonly TraceAnchorState[] | undefined {
  if (!Array.isArray(document) || document.length === 0) return undefined;
  const states = each(document, (state) => (isTraceAnchorState(state) ? state : undefined));
  if (states === undefined) return undefined;
  return states.every((state, index) => index === 0 || states[index - 1]! < state) ? states : undefined;
}

/** A well-formed position: two safe integers with the index inside the count. */
function readPosition(document: unknown): TracePosition | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const { index, of } = document as Record<string, unknown>;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(of)) return undefined;
  // `of: 1` is an anonymous target counted alone (`describePosition`); a named target never records a position under two.
  if ((of as number) < 1 || (of as number) > MAX_TRACE_POSITION_OF) return undefined;
  if ((index as number) < 0 || (index as number) >= (of as number)) return undefined;
  return { index: index as number, of: of as number };
}

function readProvenance(document: unknown): TraceProvenance | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const testId = readBoundedText(raw['testId'], MAX_TRACE_DESCRIPTOR_CHARS);
  const targetId = readBoundedText(raw['targetId'], MAX_TRACE_DESCRIPTOR_CHARS);
  const instructionDigest = raw['instructionDigest'];
  if (testId === undefined || targetId === undefined) return undefined;
  if (typeof instructionDigest !== 'string' || !SHA256_HEX.test(instructionDigest)) return undefined;
  const paramsDigest = raw['paramsDigest'];
  if (paramsDigest !== undefined && (typeof paramsDigest !== 'string' || !SHA256_HEX.test(paramsDigest))) return undefined;
  const callIndex = raw['callIndex'];
  if (callIndex !== undefined && (typeof callIndex !== 'number' || !Number.isSafeInteger(callIndex) || callIndex < 0)) {
    return undefined;
  }
  const agent = raw['agent'] === undefined ? undefined : readBoundedText(raw['agent'], MAX_TRACE_DESCRIPTOR_CHARS);
  if (raw['agent'] !== undefined && agent === undefined) return undefined;
  return {
    testId,
    targetId,
    instructionDigest,
    ...(paramsDigest === undefined ? {} : { paramsDigest }),
    ...(callIndex === undefined ? {} : { callIndex }),
    ...(agent === undefined ? {} : { agent }),
  };
}

/** One to `MAX_TRACE_UPLOAD_PATHS` verbatim paths, each a replay input like a typed value. */
function readInputPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRACE_UPLOAD_PATHS) return undefined;
  return each(value, readInputText);
}

/** Verbatim replay input: bounded but never trimmed — whitespace can be the value. */
function readInputText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_TRACE_INPUT_CHARS) {
    return undefined;
  }
  return value;
}

/** A typed value: `readInputText`, except that `''` is valid, since typing it clears a field. */
function readTypedValue(value: unknown): string | undefined {
  return value === '' ? value : readInputText(value);
}
