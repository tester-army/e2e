/**
 * `trace-1` entry format (RFC0001 layer 3, cache-in decision).
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

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

/**
 * How a recorded action addressed its node, independent of observation ids.
 * Ids are minted per observation, so replay re-finds the node from the
 * semantic fields against a fresh observation, and whatever they resolve to
 * is still checked before use. The structural `selector` is captured as
 * provenance for tuned replay policies; the conservative policy ignores it.
 */
export interface TraceTargetDescriptor {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly selector?: string;
  readonly inputPurpose?: string;
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
}

export interface NavigateAction extends ActionBase {
  readonly name: 'navigate';
  readonly url: string;
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
  | ToolGapAction;

export interface ActionTrace {
  readonly actions: readonly RecordedAction[];
  /** Executor that produced the trace — provenance, never part of the key (OQ10). */
  readonly executor: { readonly name: string; readonly version?: string };
  /** The recorded run's verdict summary. */
  readonly summary: string;
  /** Page path when the step began; a precondition unless the trace opens with navigate. */
  readonly startPath?: string;
  /** Set when recording overflowed a cap; the trace documents, never replays. */
  readonly truncated?: boolean;
}

export interface TraceEntry {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly payload: ActionTrace;
}

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
  const payload = readActionTrace(raw['payload']);
  if (payload === undefined) return undefined;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    payload,
  };
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

  const summary = readBoundedText(raw['summary'], MAX_TRACE_SUMMARY_CHARS);
  if (summary === undefined) return undefined;

  const startPath = raw['startPath'];
  if (startPath !== undefined) {
    if (typeof startPath !== 'string' || startPath === '' || startPath.length > MAX_TRACE_DESCRIPTOR_CHARS) {
      return undefined;
    }
  }
  const truncated = raw['truncated'];
  if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;

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
    summary,
    ...(startPath === undefined ? {} : { startPath }),
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
      return {
        name: 'scroll',
        summary,
        direction: direction as ScrollDirection,
        ...(target === undefined ? {} : { target }),
      };
    }
    case 'navigate': {
      const url = readInputText(raw['url']);
      return url === undefined ? undefined : { name: 'navigate', summary, url };
    }
    case 'tool':
      return { name: 'tool', summary };
    default:
      return undefined;
  }
}

const DESCRIPTOR_FIELDS = [
  'role',
  'name',
  'text',
  'testId',
  'placeholder',
  'selector',
  'inputPurpose',
] as const;

function readDescriptor(document: unknown): TraceTargetDescriptor | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  const descriptor: Record<string, string> = {};
  for (const field of DESCRIPTOR_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_TRACE_DESCRIPTOR_CHARS) return undefined;
    if (value !== '') descriptor[field] = value;
  }
  if (Object.keys(descriptor).length === 0) return undefined;
  return descriptor as TraceTargetDescriptor;
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
