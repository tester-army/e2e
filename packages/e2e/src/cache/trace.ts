/**
 * `trace-1` entry format.
 *
 * A trace is the ordered list of grammar actions one passing `agent.act()`
 * step performed, each with a durable target descriptor and secret-free,
 * verbatim input — never model output, never plaintext secrets. An entry is
 * deliberately small: a schema version, when it was written, and the trace
 * with the provenance it had. It does not repeat its own key: the file name
 * is the key digest and a reader only ever opens the digest of the key it
 * just computed.
 *
 * Actions are a discriminated union: each variant carries exactly the typed
 * input its grammar action needs, so validation here is the one owner of
 * replayability — a document that reads back as an entry replays verbatim,
 * and a document this runner cannot replay verbatim comes back as
 * `undefined`, never as a repaired or partially trusted entry.
 */

import { timestamp } from '../internal/ids.ts';
import type { ScrollDirection } from '../types.ts';

export const TRACE_SCHEMA_VERSION = 'trace-1';

/** Mirrors the default step action budget; overflow marks the trace truncated. */
export const MAX_TRACE_ACTIONS = 50;

/** Prose caps keep an entry a receipt, not a transcript. */
export const MAX_TRACE_SUMMARY_CHARS = 300;
export const MAX_TRACE_DESCRIPTOR_CHARS = 300;

/**
 * Cap on verbatim replay inputs (typed text, URLs, option labels). Inputs are
 * never truncated to fit — a trimmed URL or half a typed value would replay a
 * different action than the one recorded — so an oversized input poisons the
 * trace (`truncated`) instead of bending the value.
 */
export const MAX_TRACE_INPUT_CHARS = 4_096;

/** Caps prose at `maxChars`, marking the cut with an ellipsis. */
export function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Cap on recorded end anchors. Anchors are the step's own delta — what
 * appeared on screen between the first observation and the passing one — so
 * a same-screen mutation rarely has more than a handful; a step that changes
 * the whole screen keeps the first few in document order.
 */
export const MAX_TRACE_ANCHORS = 8;
/** Longest a replay waits for the recorded end state to return. */
export const MAX_TRACE_END_WAIT_MS = 120_000;

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

/** The shape of a SHA-256 digest in hex, as `instructionDigest` writes it. */
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/**
 * What a trace was recorded for, in the terms a person uses: the test, the
 * target, and the digest of the instruction. None of it is replay input —
 * every one of these fields is already in the key, so a mismatch is a miss
 * before an entry is ever read — and none of it is trusted as such. It exists
 * so a file named after a digest can say which test it belongs to.
 */
export interface TraceProvenance {
  readonly testId: string;
  readonly targetId: string;
  /** SHA-256 of the normalized instruction (`cache/identity.ts`). */
  readonly instructionDigest: string;
}

/**
 * How a recorded action addressed its node, independent of observation ids.
 * Ids are minted per observation, so replay re-finds the node from the
 * semantic fields against a fresh observation, and whatever they resolve to
 * is still checked before use. The structural `selector` is captured as
 * provenance for tuned replay policies; the conservative policy ignores it.
 */
/** A target's place, in document order, among the controls its recorded fields also matched. */
export interface TracePosition {
  readonly index: number;
  readonly of: number;
}

/** Most twins a positional recording distinguishes between; beyond it a list is data, not a control set. */
const MAX_TRACE_POSITION_OF = 1000;

export interface TraceTargetDescriptor {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly selector?: string;
  readonly inputPurpose?: string;
  /** Key of the container the target sat in (a row's first cell); relocation requires the same. */
  readonly within?: string;
  /**
   * Set only when the other fields matched several controls on the recording
   * screen (one unlabeled "Set up" per card): which of them the target was.
   * Replay honors it only when the live screen shows exactly as many, so a
   * twin that appeared or vanished still diverges instead of guessing.
   */
  readonly position?: TracePosition;
}

interface ActionBase {
  /** One-line prose summary — the only view a mid-step hand-off notice shows. */
  readonly summary: string;
}

export interface TapAction extends ActionBase {
  readonly name: 'tap';
  readonly target: TraceTargetDescriptor;
}

export interface TypeAction extends ActionBase {
  readonly name: 'type';
  readonly target: TraceTargetDescriptor;
  readonly value: string;
}

/** A secret fill, recorded by its stable name only — never the plaintext. */
export interface TypeSecretAction extends ActionBase {
  readonly name: 'typeSecret';
  readonly target: TraceTargetDescriptor;
  readonly secret: string;
}

export interface PressAction extends ActionBase {
  readonly name: 'press';
  readonly target: TraceTargetDescriptor;
  readonly key: string;
}

export interface SelectAction extends ActionBase {
  readonly name: 'select';
  readonly target: TraceTargetDescriptor;
  readonly value: string;
}

export interface ScrollAction extends ActionBase {
  readonly name: 'scroll';
  readonly direction: ScrollDirection;
  readonly target?: TraceTargetDescriptor;
  /** Consecutive identical scrolls folded into one action; absent means one. */
  readonly times?: number;
  /**
   * The share of the viewport the target covered when recorded, 0 to 1. A
   * list that filled the screen (`MAIN_LIST_SHARE`) scrolls as the viewport
   * does when replay cannot re-find it; a smaller region never does.
   */
  readonly spans?: number;
}

export interface NavigateAction extends ActionBase {
  readonly name: 'navigate';
  readonly url: string;
}

/** A viewport size in CSS pixels, the precondition of a replayed point. */
export interface TraceViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * A tap at a bare viewport point, the way a coordinate-driven tool replays:
 * the same point on the same-sized viewport. When a listed node with a
 * durable descriptor contained the point, the point's place inside that
 * node's box is kept too, and replay re-finds the node and taps the same
 * place in its live box, so a layout shift moves the tap with it. The end
 * anchors decide whether the tap did what it did the first time.
 */
export interface TapAtAction extends ActionBase {
  readonly name: 'tapAt';
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: TraceViewport;
  readonly within?: {
    readonly target: TraceTargetDescriptor;
    /** The point's place inside the node's box, 0 at the left or top edge and 1 at the right or bottom. */
    readonly fx: number;
    readonly fy: number;
  };
}

/**
 * Keyboard input to whatever held focus, replayed as given: the focus it
 * relies on is the effect of the recorded actions before it (a bare-point tap
 * on a drawn field), and the end anchors decide whether it landed.
 */
export interface TypeTextAction extends ActionBase {
  readonly name: 'typeText';
  readonly value: string;
  readonly replace: boolean;
}

export interface PressKeyAction extends ActionBase {
  readonly name: 'pressKey';
  readonly key: string;
}

export interface DismissKeyboardAction extends ActionBase {
  readonly name: 'dismissKeyboard';
}

/**
 * A project-tool mutation the grammar cannot reproduce — a gap that ends any
 * replay rather than silently skipping a state change.
 */
export interface ToolGapAction extends ActionBase {
  readonly name: 'tool';
}

export type RecordedAction =
  | TapAction
  | TypeAction
  | TypeSecretAction
  | PressAction
  | SelectAction
  | ScrollAction
  | NavigateAction
  | TapAtAction
  | TypeTextAction
  | PressKeyAction
  | DismissKeyboardAction
  | ToolGapAction;

export interface ActionTrace {
  readonly actions: readonly RecordedAction[];
  /** Executor that produced the trace — provenance, never part of the key (OQ10). */
  readonly executor: { readonly name: string; readonly version?: string };
  /** Which test, target, and instruction recorded it; absent on older entries. */
  readonly recordedFor?: TraceProvenance;
  /** The recorded run's verdict summary. */
  readonly summary: string;
  /** Location path when the step began; a precondition unless the trace opens with navigate. */
  readonly startPath?: string;
  /**
   * Location path when the step passed — the trace's deterministic postcondition.
   * A full replay self-finalizes only while the live pathname still matches;
   * a recorded flow whose destination changed hands off instead of passing.
   */
  readonly endPath?: string;
  /**
   * Descriptors of nodes that were on screen when the step passed and were
   * not there when it began — the recorded run's verification, made
   * mechanical. A full replay self-finalizes only while every anchor is
   * present again; a flow whose actions replayed but whose effect did not
   * (a save that never committed, an unnamed form left behind) hands off
   * instead of passing on mechanics alone.
   */
  readonly endAnchors?: readonly TraceTargetDescriptor[];
  /**
   * How long the recorded run took from its first action to its passing
   * verdict, plus a margin. A replay waits up to this long for the anchors to
   * appear: the recorded run waited for its effect too (a report that takes
   * half a minute), and the click alone proves nothing.
   */
  readonly endWaitMs?: number;
  /** Set when recording overflowed a cap; the trace documents, never replays. */
  readonly truncated?: boolean;
}

export interface TraceEntry {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly payload: ActionTrace;
}

/** The shape `timestamp()` writes: an ISO 8601 UTC instant. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Wraps one trace as a fresh entry. */
export function buildTraceEntry(payload: ActionTrace): TraceEntry {
  return { schemaVersion: TRACE_SCHEMA_VERSION, createdAt: timestamp(), payload };
}

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

  const summary = readBoundedText(raw['summary'], MAX_TRACE_SUMMARY_CHARS);
  if (summary === undefined) return undefined;

  const startPath = raw['startPath'];
  if (startPath !== undefined) {
    if (typeof startPath !== 'string' || startPath === '' || startPath.length > MAX_TRACE_DESCRIPTOR_CHARS) {
      return undefined;
    }
  }
  const endPath = raw['endPath'];
  if (endPath !== undefined) {
    if (typeof endPath !== 'string' || endPath === '' || endPath.length > MAX_TRACE_DESCRIPTOR_CHARS) {
      return undefined;
    }
  }
  const truncated = raw['truncated'];
  if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;

  const endWaitMs = raw['endWaitMs'];
  if (
    endWaitMs !== undefined &&
    (typeof endWaitMs !== 'number' || !Number.isInteger(endWaitMs) || endWaitMs < 0 || endWaitMs > MAX_TRACE_END_WAIT_MS)
  ) {
    return undefined;
  }
  const anchorsRaw = raw['endAnchors'];
  let endAnchors: TraceTargetDescriptor[] | undefined;
  if (anchorsRaw !== undefined) {
    if (!Array.isArray(anchorsRaw) || anchorsRaw.length > MAX_TRACE_ANCHORS) return undefined;
    endAnchors = [];
    for (const entry of anchorsRaw) {
      const descriptor = readDescriptor(entry);
      if (descriptor === undefined) return undefined;
      endAnchors.push(descriptor);
    }
  }

  const actionsRaw = raw['actions'];
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0 || actionsRaw.length > MAX_TRACE_ACTIONS) {
    return undefined;
  }
  const actions: RecordedAction[] = [];
  for (const entry of actionsRaw) {
    const action = readRecordedAction(entry);
    if (action === undefined) return undefined;
    actions.push(action);
  }

  return {
    actions,
    executor: {
      name: executorName,
      ...(executorVersion === undefined ? {} : { version: executorVersion }),
    },
    ...(recordedFor === undefined ? {} : { recordedFor }),
    summary,
    ...(startPath === undefined ? {} : { startPath }),
    ...(endPath === undefined ? {} : { endPath }),
    ...(endAnchors === undefined || endAnchors.length === 0 ? {} : { endAnchors }),
    ...(endWaitMs === undefined ? {} : { endWaitMs }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}


function readRecordedAction(document: unknown): RecordedAction | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const summary = readBoundedText(raw['summary'], MAX_TRACE_SUMMARY_CHARS);
  if (summary === undefined) return undefined;

  switch (raw['name']) {
    case 'tap': {
      const target = readDescriptor(raw['target']);
      return target === undefined ? undefined : { name: 'tap', summary, target };
    }
    case 'type': {
      const target = readDescriptor(raw['target']);
      const value = readInputText(raw['value']);
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
    case 'scroll': {
      const direction = raw['direction'];
      if (typeof direction !== 'string' || !SCROLL_DIRECTIONS.has(direction)) return undefined;
      const target = raw['target'] === undefined ? undefined : readDescriptor(raw['target']);
      if (raw['target'] !== undefined && target === undefined) return undefined;
      const times = raw['times'];
      if (times !== undefined && (typeof times !== 'number' || !Number.isInteger(times) || times < 2)) return undefined;
      const spans = raw['spans'];
      if (spans !== undefined && (typeof spans !== 'number' || !(spans >= 0 && spans <= 1))) return undefined;
      return {
        name: 'scroll',
        summary,
        direction: direction as ScrollDirection,
        ...(target === undefined ? {} : { target }),
        ...(times === undefined ? {} : { times }),
        ...(spans === undefined ? {} : { spans }),
      };
    }
    case 'navigate': {
      const url = readInputText(raw['url']);
      return url === undefined ? undefined : { name: 'navigate', summary, url };
    }
    case 'tapAt': {
      const point = readPoint(raw['point']);
      const viewport = readViewport(raw['viewport']);
      if (point === undefined || viewport === undefined) return undefined;
      const within = raw['within'] === undefined ? undefined : readWithin(raw['within']);
      if (raw['within'] !== undefined && within === undefined) return undefined;
      return { name: 'tapAt', summary, point, viewport, ...(within === undefined ? {} : { within }) };
    }
    case 'typeText': {
      const value = readInputText(raw['value']);
      if (value === undefined || typeof raw['replace'] !== 'boolean') return undefined;
      return { name: 'typeText', summary, value, replace: raw['replace'] };
    }
    case 'pressKey': {
      const key = readBoundedText(raw['key'], 64);
      return key === undefined ? undefined : { name: 'pressKey', summary, key };
    }
    case 'dismissKeyboard':
      return { name: 'dismissKeyboard', summary };
    case 'tool':
      return { name: 'tool', summary };
    default:
      return undefined;
  }
}

function readPoint(document: unknown): TapAtAction['point'] | undefined {
  const raw = readObject(document);
  const x = raw?.['x'];
  const y = raw?.['y'];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
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

function readWithin(document: unknown): NonNullable<TapAtAction['within']> | undefined {
  const raw = readObject(document);
  const target = raw === undefined ? undefined : readDescriptor(raw['target']);
  const fx = raw?.['fx'];
  const fy = raw?.['fy'];
  if (target === undefined || !isFraction(fx) || !isFraction(fy)) return undefined;
  return { target, fx, fy };
}

function isFraction(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function readObject(document: unknown): Record<string, unknown> | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  return document as Record<string, unknown>;
}

/** Every field of a target descriptor; two descriptors equal on all of them name the same target. */
export const DESCRIPTOR_FIELDS = [
  'role',
  'name',
  'text',
  'testId',
  'placeholder',
  'selector',
  'inputPurpose',
  'within',
] as const;

/**
 * The descriptor fields that carry text read off the screen, where a value
 * a test supplied can reappear. `role`, `selector`, and `inputPurpose` are
 * vocabulary, never screen text.
 */
const DESCRIPTOR_TEXT_FIELDS = ['name', 'text', 'testId', 'placeholder', 'within'] as const;

/** A string rewrite; `undefined` means the text cannot be rewritten and the whole trace is unusable. */
export type TraceTextMap = (text: string) => string | undefined;

function mapDescriptorText(descriptor: TraceTargetDescriptor, map: TraceTextMap): TraceTargetDescriptor | undefined {
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

function mapActionText(action: RecordedAction, map: TraceTextMap): RecordedAction | undefined {
  const summary = map(action.summary);
  if (summary === undefined) return undefined;
  const withSummary = <A extends RecordedAction>(next: A): A => (summary === next.summary ? next : { ...next, summary });
  const target = (descriptor: TraceTargetDescriptor) => mapDescriptorText(descriptor, map);
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

/**
 * Applies `map` to every recorded string a screen value can appear in: typed
 * and selected values, navigated URLs, both location paths, target and
 * anchor text, and the prose summaries. Keys (`press`), secret names,
 * executor identity, and provenance are vocabulary and are left alone. The
 * one list of text-bearing fields lives here, beside the union it walks;
 * `undefined` from `map` makes the whole result `undefined`.
 */
export function mapTraceText(trace: ActionTrace, map: TraceTextMap): ActionTrace | undefined {
  const actions: RecordedAction[] = [];
  for (const action of trace.actions) {
    const mapped = mapActionText(action, map);
    if (mapped === undefined) return undefined;
    actions.push(mapped);
  }
  const summary = map(trace.summary);
  const startPath = trace.startPath === undefined ? undefined : map(trace.startPath);
  const endPath = trace.endPath === undefined ? undefined : map(trace.endPath);
  if (summary === undefined || (trace.startPath !== undefined && startPath === undefined) || (trace.endPath !== undefined && endPath === undefined)) {
    return undefined;
  }
  const endAnchors = trace.endAnchors === undefined ? undefined : mapDescriptors(trace.endAnchors, map);
  if (trace.endAnchors !== undefined && endAnchors === undefined) return undefined;
  return {
    ...trace,
    actions,
    summary,
    ...(startPath === undefined ? {} : { startPath }),
    ...(endPath === undefined ? {} : { endPath }),
    ...(endAnchors === undefined ? {} : { endAnchors }),
  };
}

function mapDescriptors(descriptors: readonly TraceTargetDescriptor[], map: TraceTextMap): TraceTargetDescriptor[] | undefined {
  const out: TraceTargetDescriptor[] = [];
  for (const descriptor of descriptors) {
    const mapped = mapDescriptorText(descriptor, map);
    if (mapped === undefined) return undefined;
    out.push(mapped);
  }
  return out;
}

function readDescriptor(document: unknown): TraceTargetDescriptor | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const descriptor: Record<string, string | TracePosition> = {};
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
  return descriptor as TraceTargetDescriptor;
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
  return { testId, targetId, instructionDigest };
}

function readBoundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars) {
    return undefined;
  }
  return value;
}

/** Verbatim replay input: bounded but never trimmed — whitespace can be the value. */
function readInputText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_TRACE_INPUT_CHARS) {
    return undefined;
  }
  return value;
}
