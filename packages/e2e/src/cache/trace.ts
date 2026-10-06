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
import { bound } from '../internal/text.ts';

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

/**
 * A node as one line of prose names it, `button "Save"`: its role and its
 * best label (name, text, placeholder, then test id), the label bounded.
 * Every report line that names a node an action or a recording points at
 * reads it this way.
 */
export function targetLabel(target: Pick<TraceTargetDescriptor, 'role' | 'name' | 'text' | 'placeholder' | 'testId'>): string {
  const label = target.name ?? target.text ?? target.placeholder ?? target.testId ?? '';
  const role = target.role ?? 'node';
  return label === '' ? role : `${role} ${JSON.stringify(bound(label, 40))}`;
}

/**
 * Cap on recorded anchors, per side of the delta. Anchors are the step's own
 * delta, what appeared on screen between the first observation and the
 * passing one and what vanished, so a same-screen mutation rarely has more
 * than a handful; a step that changes the whole screen keeps the first few,
 * announcements first (`cache/anchors.ts`).
 */
export const MAX_TRACE_ANCHORS = 8;
/** Longest a replay waits for the recorded end state to return. */
export const MAX_TRACE_END_WAIT_MS = 120_000;

/** A membership test over a closed list of names, typed as the names themselves: the read sites need no cast. */
function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const set: ReadonlySet<unknown> = new Set(values);
  return (value): value is T => set.has(value);
}

const isScrollDirection = oneOf(['up', 'down', 'left', 'right'] as const satisfies readonly ScrollDirection[]);

/**
 * Reads every item, or nothing: one item this runner cannot read makes the
 * whole list unreadable, so an entry is replayed verbatim or not at all.
 */
function each<T, U>(items: readonly T[], read: (item: T) => U | undefined): U[] | undefined {
  const out: U[] = [];
  for (const item of items) {
    const value = read(item);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
}

/** The shape of a SHA-256 digest in hex, as `instructionDigest` writes it. */
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/**
 * What a trace was recorded for, in the terms a person uses: the test, the
 * target, the digest of the instruction, and, on entries recorded since they
 * were added, the rest of what names the step within its test. None of it is
 * replay input — every one of these fields is already in the key, so a
 * mismatch is a miss before an entry is ever read — and none of it is trusted
 * as such. It exists so a file named after a digest can say which step it
 * belongs to, and so `cache.strict` can tell a step whose key changed under
 * its recording from a step that was never recorded.
 */
export interface TraceProvenance {
  readonly testId: string;
  readonly targetId: string;
  /** SHA-256 of the normalized instruction (`cache/identity.ts`). */
  readonly instructionDigest: string;
  /** SHA-256/JCS of the step's params as the key digests them, a placeholder for each `unique()` value. */
  readonly paramsDigest?: string;
  /** Zero-based occurrence of the step among its repeats in the attempt. */
  readonly callIndex?: number;
  /** Name of the configured agent the step ran with. */
  readonly agent?: string;
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
  /**
   * An anchor's states that were on, sorted; anchors only. A switch turned
   * on is the same control before and after, so its state is what tells
   * the step's effect from a tap that did nothing.
   */
  readonly states?: readonly TraceAnchorState[];
  /**
   * An anchor's current input value, redacted and bounded like its text;
   * anchors only, and never a secure field's, which is never observed. A
   * field typed into or an option selected is the same control before and
   * after, so its value is the step's effect.
   */
  readonly value?: string;
}

/** The node states an anchor records: the ones a step sets on a control it leaves on screen. */
export const TRACE_ANCHOR_STATES = ['checked', 'expanded', 'pressed', 'selected'] as const;

export type TraceAnchorState = (typeof TRACE_ANCHOR_STATES)[number];

const isTraceAnchorState = oneOf(TRACE_ANCHOR_STATES);

interface ActionBase {
  /** One-line prose summary — the only view a mid-step hand-off notice shows. */
  readonly summary: string;
}

/** The verbs that act on one node and carry no input: tap and its variants, hover, scroll into view. */
const NODE_ACTION_NAMES = ['tap', 'doubleTap', 'longPress', 'secondaryTap', 'hover', 'scrollTo'] as const;

export type NodeActionName = (typeof NODE_ACTION_NAMES)[number];

const isNodeActionName = oneOf(NODE_ACTION_NAMES);

/**
 * Whether an action is one of the node verbs. The every-layer switches over
 * an action union (prose, recording, templating, replay) take these six
 * through one branch, so the list is spelled once, here.
 */
export function isNodeAction<A extends { readonly name: string }>(action: A): action is Extract<A, { readonly name: NodeActionName }> {
  return isNodeActionName(action.name);
}

export interface NodeAction extends ActionBase {
  readonly name: NodeActionName;
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

/** A checkbox, switch, or radio set to a state; replay sets the same state rather than flipping. */
export interface CheckAction extends ActionBase {
  readonly name: 'check';
  readonly target: TraceTargetDescriptor;
  readonly checked: boolean;
}

/**
 * Files attached to an input, by project-relative path. The paths are the
 * executor's own input, never screen text, and replay runs them through the
 * same project-root authorization the recording did.
 */
export interface UploadAction extends ActionBase {
  readonly name: 'upload';
  readonly target: TraceTargetDescriptor;
  readonly paths: readonly string[];
}

/** Most files one upload carries; more is a script, not a form. */
export const MAX_TRACE_UPLOAD_PATHS = 16;

/** A drag from one node onto another; both are re-found before replay drags. */
export interface DragAction extends ActionBase {
  readonly name: 'drag';
  readonly target: TraceTargetDescriptor;
  readonly destination: TraceTargetDescriptor;
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

/** A list paged until a node reading `text` showed; `target` is the list as last paged, absent for the viewport. */
export interface ScrollUntilAction extends ActionBase {
  readonly name: 'scrollUntil';
  readonly text: string;
  readonly direction: ScrollDirection;
  readonly target?: TraceTargetDescriptor;
  /** As `ScrollAction.spans`. */
  readonly spans?: number;
}

export interface NavigateAction extends ActionBase {
  readonly name: 'navigate';
  readonly url: string;
}

/** One step back in the history or the app, replayed as given. */
export interface BackAction extends ActionBase {
  readonly name: 'back';
}

/** A viewport size in CSS pixels, the precondition of a replayed point. */
export interface TraceViewport {
  readonly width: number;
  readonly height: number;
}

/** The verbs that act on a bare viewport point. */
export type PointActionName = 'tapAt' | 'hoverAt';

/**
 * A tap or hover at a bare viewport point, the way a coordinate-driven tool
 * replays: the same point on the same-sized viewport. When a listed node
 * with a durable descriptor contained the point, the point's place inside
 * that node's box is kept too, and replay re-finds the node and acts at the
 * same place in its live box, so a layout shift moves the point with it.
 * The end anchors decide whether the action did what it did the first time.
 */
export interface PointAction extends ActionBase {
  readonly name: PointActionName;
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
 * Why a typed value was this run's data rather than the flow's, by the rule
 * that flagged it (`agent/derived.ts`): read off a screenshot, the whole name
 * or text of a node, a token with a digit shown as a word of its own, or a
 * date or time reckoned from today.
 */
export type DerivedReason = 'pixels' | 'whole-node' | 'minted-token' | 'date';

const isDerivedReason = oneOf(['pixels', 'whole-node', 'minted-token', 'date'] as const satisfies readonly DerivedReason[]);

/**
 * A gap that ends any replay rather than silently skipping what the grammar
 * cannot reproduce: a project-tool mutation, or a fill whose value was this
 * run's data, which carries the rule that said so. The wire name stays
 * `tool` for both, as the entries already recorded spell it.
 */
export interface ToolGapAction extends ActionBase {
  readonly name: 'tool';
  readonly derived?: DerivedReason;
}

export type RecordedAction =
  | NodeAction
  | TypeAction
  | TypeSecretAction
  | PressAction
  | SelectAction
  | CheckAction
  | UploadAction
  | DragAction
  | ScrollAction
  | ScrollUntilAction
  | NavigateAction
  | BackAction
  | PointAction
  | TypeTextAction
  | PressKeyAction
  | DismissKeyboardAction
  | ToolGapAction;

export interface ActionTrace {
  readonly actions: readonly RecordedAction[];
  /** Executor that produced the trace: provenance, never part of the key, which names the agent instead. */
  readonly executor: { readonly name: string; readonly version?: string };
  /** Which test, target, and instruction recorded it; absent on older entries. */
  readonly recordedFor?: TraceProvenance;
  /** The recorded run's verdict summary. */
  readonly summary: string;
  /**
   * Location when the step began, as the cache compares it (`appLocation`):
   * a path on the app's own origin, else the whole location. A precondition
   * unless the trace opens with navigate.
   */
  readonly startPath?: string;
  /**
   * Location when the step passed, spelled like `startPath`: the trace's
   * deterministic postcondition. A full replay self-finalizes only while
   * the live route still matches; a recorded flow whose destination changed
   * hands off instead of passing.
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
   * Descriptors of nodes that were on screen when the step began and were
   * gone when it passed: a delete, a dismissed dialog, a cleared draft. A
   * full replay self-finalizes only while every one of them is gone again,
   * so a removal that did not happen hands off instead of passing with no
   * anchor to check.
   */
  readonly goneAnchors?: readonly TraceTargetDescriptor[];
  /**
   * How long the recorded run took from its first action to its passing
   * verdict, plus a margin. A replay waits up to this long for the anchors to
   * appear: the recorded run waited for its effect too (a report that takes
   * half a minute), and the click alone proves nothing.
   */
  readonly endWaitMs?: number;
  /** Set when recording overflowed a cap; the trace documents, never replays. */
  readonly truncated?: boolean;
  /**
   * The parts of the key that are not the step itself, as they were when it
   * was recorded: provenance, never read by a replay. When a step's key no
   * longer finds this entry, comparing them with the run's says what changed
   * (an engine minor, the replay policy, the app's identity); absent on older
   * entries.
   */
  readonly keyedBy?: TraceKeyContext;
}

/**
 * Every part of a cache key outside the step's own identity (the runner, the
 * engine, the app, and the agent's context), in the order an entry records
 * them and a changed key names them. One list drives the type, the copy of a
 * key, the read of a stored one, and the comparison of two.
 */
export const KEY_CONTEXT_FIELDS = [
  'cacheSchema',
  'policyVersion',
  'project',
  'platform',
  'engineName',
  'engineVersion',
  'engineSpiVersion',
  'appIdentity',
  'agentContextDigest',
] as const;

/** The one numeric part; every other is text. */
type KeyContextNumber = 'engineSpiVersion';

/** The parts of a cache key outside the step's own identity (`KEY_CONTEXT_FIELDS`). */
export type TraceKeyContext = {
  readonly [Field in (typeof KEY_CONTEXT_FIELDS)[number]]: Field extends KeyContextNumber ? number : string;
};

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
    return target === undefined ? undefined : { name, summary, target };
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
      const point = readPoint(raw['point']);
      const viewport = readViewport(raw['viewport']);
      if (point === undefined || viewport === undefined) return undefined;
      const within = raw['within'] === undefined ? undefined : readWithin(raw['within']);
      if (raw['within'] !== undefined && within === undefined) return undefined;
      return { name, summary, point, viewport, ...(within === undefined ? {} : { within }) };
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

function readPoint(document: unknown): PointAction['point'] | undefined {
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

function readWithin(document: unknown): NonNullable<PointAction['within']> | undefined {
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
  'value',
] as const;

/**
 * The descriptor fields that carry text read off the screen, where a value
 * a test supplied can reappear. `role`, `selector`, and `inputPurpose` are
 * vocabulary, never screen text.
 */
const DESCRIPTOR_TEXT_FIELDS = ['name', 'text', 'testId', 'placeholder', 'within', 'value'] as const;

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
  /** An action whose only text beyond the summary is its target. */
  const targetOnly = <A extends RecordedAction & { readonly target: TraceTargetDescriptor }>(targeted: A): A | undefined => {
    const mapped = target(targeted.target);
    return mapped === undefined ? undefined : withSummary({ ...targeted, target: mapped });
  };
  if (isNodeAction(action)) return targetOnly(action);
  switch (action.name) {
    case 'typeSecret':
    case 'press':
    case 'check':
      return targetOnly(action);
    case 'type':
    case 'select': {
      const mapped = target(action.target);
      const value = map(action.value);
      return mapped === undefined || value === undefined ? undefined : withSummary({ ...action, target: mapped, value });
    }
    case 'upload': {
      // Paths are replay inputs like a typed value: a file named through
      // `unique()` must be re-resolved from each run's value, or the replay
      // would upload the recording run's file.
      const mapped = target(action.target);
      const paths = each(action.paths, map);
      return mapped === undefined || paths === undefined ? undefined : withSummary({ ...action, target: mapped, paths });
    }
    case 'drag': {
      const mapped = target(action.target);
      const destination = target(action.destination);
      return mapped === undefined || destination === undefined ? undefined : withSummary({ ...action, target: mapped, destination });
    }
    case 'scroll': {
      if (action.target === undefined) return withSummary(action);
      const mapped = target(action.target);
      return mapped === undefined ? undefined : withSummary({ ...action, target: mapped });
    }
    case 'scrollUntil': {
      const text = map(action.text);
      if (text === undefined) return undefined;
      if (action.target === undefined) return withSummary({ ...action, text });
      const mapped = target(action.target);
      return mapped === undefined ? undefined : withSummary({ ...action, text, target: mapped });
    }
    case 'navigate': {
      const url = map(action.url);
      return url === undefined ? undefined : withSummary({ ...action, url });
    }
    case 'typeText': {
      const value = map(action.value);
      return value === undefined ? undefined : withSummary({ ...action, value });
    }
    case 'tapAt':
    case 'hoverAt': {
      if (action.within === undefined) return withSummary(action);
      const mapped = target(action.within.target);
      return mapped === undefined ? undefined : withSummary({ ...action, within: { ...action.within, target: mapped } });
    }
    case 'back':
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
  const actions = each(trace.actions, (action) => mapActionText(action, map));
  if (actions === undefined) return undefined;
  const summary = map(trace.summary);
  const startPath = trace.startPath === undefined ? undefined : map(trace.startPath);
  const endPath = trace.endPath === undefined ? undefined : map(trace.endPath);
  if (summary === undefined || (trace.startPath !== undefined && startPath === undefined) || (trace.endPath !== undefined && endPath === undefined)) {
    return undefined;
  }
  const endAnchors = trace.endAnchors === undefined ? undefined : mapDescriptors(trace.endAnchors, map);
  if (trace.endAnchors !== undefined && endAnchors === undefined) return undefined;
  const goneAnchors = trace.goneAnchors === undefined ? undefined : mapDescriptors(trace.goneAnchors, map);
  if (trace.goneAnchors !== undefined && goneAnchors === undefined) return undefined;
  return {
    ...trace,
    actions,
    summary,
    ...(startPath === undefined ? {} : { startPath }),
    ...(endPath === undefined ? {} : { endPath }),
    ...(endAnchors === undefined ? {} : { endAnchors }),
    ...(goneAnchors === undefined ? {} : { goneAnchors }),
  };
}

function mapDescriptors(descriptors: readonly TraceTargetDescriptor[], map: TraceTextMap): TraceTargetDescriptor[] | undefined {
  return each(descriptors, (descriptor) => mapDescriptorText(descriptor, map));
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

function readBoundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars) {
    return undefined;
  }
  return value;
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
