/**
 * Pinned steps: `steps-1` documents kept beside the test.
 *
 * A pinned `agent.act()` step replays its recording or fails; it never calls
 * the model. Its recording lives where a reviewer finds it: in
 * `<test>.steps.json` next to the test file (`tests/checkout.e2e.ts` keeps
 * `tests/checkout.e2e.steps.json`), or, for a call that holds them in its
 * `steps` option, its actions in the test itself and the rest of its trace
 * in the same steps file.
 *
 * The replay cache's key mixes two questions into one digest: which step
 * this is, and whether the recording still holds. A pinned step keeps them
 * apart. Its identity (`PinnedStepId`: the test's title path, the target,
 * the agent, the instruction, the params as the key spells them, and the
 * occurrence) finds the entry, and its recorded context (`recordedWith`:
 * the engine and its contract, the replay policy, the app's identity, the
 * agent's context) is compared after it is found, so a change there is a
 * `REPLAY_STALE` that names it, never a silent model call.
 *
 * A pinned trace holds what a `trace-1` entry holds, without its provenance
 * fields, which the step's identity and `recordedWith` replace. It is
 * secret-free the same way: a secret fill is a `typeSecret` action holding
 * the secret's name, and a `unique()` value is a `{{param:<pointer>}}`
 * placeholder the current call fills.
 */

import { readFile } from 'node:fs/promises';
import { canonicalJson, timestamp } from '../internal/ids.ts';
import { errorMessage } from '../internal/errors.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import type { JsonValue } from '../types.ts';
import { normalizeInstruction } from './identity.ts';
import { opensWithNavigate } from './decide.ts';
import { readActionTrace, readRecordedActions } from './trace-read.ts';
import { readBoundedText } from './trace-fields.ts';
import {
  KEY_CONTEXT_FIELDS,
  MAX_TRACE_ACTIONS,
  MAX_TRACE_DESCRIPTOR_CHARS,
  MAX_TRACE_SUMMARY_CHARS,
  targetLabel,
  type ActionTrace,
  type RecordedAction,
  type TraceKeyContext,
  type TraceTargetDescriptor,
} from './trace.ts';

const PINS_SCHEMA_VERSION = 'steps-1';

/** What a steps file is named after its test: `checkout.e2e.ts` keeps `checkout.e2e.steps.json`. */
const PINS_FILE_SUFFIX = '.steps.json';

/** Ceiling on one steps file, read or written: fifty steps at the trace cache's per-entry limit would be absurd, so is this. */
const MAX_PINS_FILE_BYTES = 16 * 1_048_576;

/** The extensions a test file may have, stripped before the suffix is added. */
const TEST_FILE_EXTENSION = /\.[cm]?[jt]sx?$/u;

/** The steps file of one test file, in the same directory. */
export function pinsFileFor(testFile: string): string {
  return `${testFile.replace(TEST_FILE_EXTENSION, '')}${PINS_FILE_SUFFIX}`;
}

/** Which step a pinned recording belongs to, in the terms the test spells it. */
export interface PinnedStepId {
  /** The test's title path, outermost describe first. */
  readonly test: readonly string[];
  readonly target: string;
  /** The configured agent the step ran with. */
  readonly agent: string;
  /** The instruction as the step received it: normalized, with registered secret values masked. */
  readonly instruction: string;
  /** The params as the cache key spells them: a placeholder for each `unique()` value, a Secret by name. */
  readonly params: Readonly<Record<string, JsonValue>>;
  /** Zero-based occurrence of the same instruction and params by the same agent within the attempt. */
  readonly callIndex: number;
}

/** A trace as a steps file stores it: the trace-1 payload without the provenance the step's identity replaces. */
export type PinnedTrace = Omit<ActionTrace, 'recordedFor' | 'keyedBy'>;

export interface PinnedStep extends PinnedStepId {
  /** When the recording was pinned, as an ISO 8601 instant. */
  readonly recordedAt: string;
  /** The context the recording holds in: another value of any field is a stale recording (`REPLAY_STALE`). */
  readonly recordedWith: TraceKeyContext;
  /**
   * The actions live in the call's `steps` option, not here: `trace` holds
   * the rest of the recording (the screen it starts on, the end state it
   * checks), and its `actions` are left out.
   */
  readonly inline?: true;
  readonly trace: PinnedTrace;
}

/** One entry of a steps file as a step finds it. */
export type PinnedEntry =
  | { readonly status: 'ok'; readonly step: PinnedStep }
  /** The identity reads, the recording does not: the step is pinned to something no runner can replay. */
  | { readonly status: 'unreadable'; readonly id: PinnedStepId; readonly reason: string };

/** A steps file as one attempt reads it. */
export type PinsBook =
  | { readonly status: 'absent' }
  | { readonly status: 'read'; readonly entries: ReadonlyMap<string, PinnedEntry> }
  /** The file exists and is not a `steps-1` document: no step of its test can say whether it is pinned. */
  | { readonly status: 'unreadable'; readonly reason: string };

/** One key per step identity: what a steps file is looked up by and merged on. */
export function pinIdKey(id: PinnedStepId): string {
  return canonicalJson([[...id.test], id.target, id.agent, normalizeInstruction(id.instruction), id.params, id.callIndex]);
}

/** Reads a steps file from disk; a missing file is no pins, anything unreadable says why. */
export async function loadPinsBook(file: string): Promise<PinsBook> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', reason: `it could not be read: ${errorMessage(cause)}` };
  }
  return readPinsBook(text);
}

/** Reads the text of a steps file. Fail-closed like the cache's own reader: nothing is repaired. */
export function readPinsBook(text: string): PinsBook {
  if (Buffer.byteLength(text, 'utf8') > MAX_PINS_FILE_BYTES) {
    return { status: 'unreadable', reason: `it is over the ${MAX_PINS_FILE_BYTES}-byte limit` };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    return { status: 'unreadable', reason: `it is not JSON: ${errorMessage(cause)}` };
  }
  if (!isObject(document) || document['schemaVersion'] !== PINS_SCHEMA_VERSION || !Array.isArray(document['steps'])) {
    return { status: 'unreadable', reason: `it is not a ${PINS_SCHEMA_VERSION} document ({ "schemaVersion": "${PINS_SCHEMA_VERSION}", "steps": [...] })` };
  }
  const entries = new Map<string, PinnedEntry>();
  for (const [index, raw] of document['steps'].entries()) {
    const id = readPinnedStepId(raw);
    if (id === undefined) return { status: 'unreadable', reason: `steps[${index}] does not say which step it pins (test, target, agent, instruction, params, callIndex)` };
    const key = pinIdKey(id);
    if (entries.has(key)) return { status: 'unreadable', reason: `steps[${index}] pins a step an earlier entry already pins` };
    const step = readPinnedStep(raw as Record<string, unknown>, id);
    entries.set(key, step === undefined ? { status: 'unreadable', id, reason: `steps[${index}] holds no recording this runner can replay` } : { status: 'ok', step });
  }
  return { status: 'read', entries };
}

function readPinnedStepId(document: unknown): PinnedStepId | undefined {
  if (!isObject(document)) return undefined;
  const test = document['test'];
  if (!Array.isArray(test) || test.length === 0 || !test.every((part) => typeof part === 'string')) return undefined;
  const target = readBoundedText(document['target'], MAX_TRACE_DESCRIPTOR_CHARS);
  const agent = readBoundedText(document['agent'], MAX_TRACE_DESCRIPTOR_CHARS);
  const instruction = typeof document['instruction'] === 'string' && document['instruction'].trim() !== '' ? document['instruction'] : undefined;
  const params = document['params'] ?? {};
  const callIndex = document['callIndex'];
  if (target === undefined || agent === undefined || instruction === undefined || !isObject(params)) return undefined;
  if (typeof callIndex !== 'number' || !Number.isSafeInteger(callIndex) || callIndex < 0) return undefined;
  return { test: test as string[], target, agent, instruction, params: params as Record<string, JsonValue>, callIndex };
}

function readPinnedStep(document: Record<string, unknown>, id: PinnedStepId): PinnedStep | undefined {
  const recordedAt = document['recordedAt'];
  if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) return undefined;
  const recordedWith = readRecordedWith(document['recordedWith']);
  if (recordedWith === undefined) return undefined;
  const inline = document['inline'];
  if (inline !== undefined && inline !== true) return undefined;
  const raw = document['trace'];
  // An inline entry's actions are in the test; any stand-in validates the rest of its trace.
  const trace = inline === true ? readActionTrace(raw, [{ name: 'back', summary: 'back' }]) : readActionTrace(raw);
  if (trace === undefined || trace.truncated === true) return undefined;
  const { recordedFor: _recordedFor, keyedBy: _keyedBy, ...pinned } = trace;
  return {
    ...id,
    recordedAt,
    recordedWith,
    ...(inline === true ? { inline: true as const, trace: { ...pinned, actions: [] } } : { trace: pinned }),
  };
}

function readRecordedWith(document: unknown): TraceKeyContext | undefined {
  if (!isObject(document)) return undefined;
  const read: Record<string, string | number> = {};
  for (const field of KEY_CONTEXT_FIELDS) {
    const value = document[field];
    if (field === 'engineSpiVersion' ? typeof value !== 'number' || !Number.isSafeInteger(value) : readBoundedText(value, MAX_TRACE_DESCRIPTOR_CHARS) === undefined) return undefined;
    read[field] = value as string | number;
  }
  return read as TraceKeyContext;
}

/**
 * Reads a call's `steps` option: the actions of a trace, each with or
 * without its `summary`. A summary the call left out is made up from the
 * action, since the replay names each action it runs.
 */
export function readInlineSteps(steps: readonly unknown[]): RecordedAction[] | undefined {
  if (steps.length === 0 || steps.length > MAX_TRACE_ACTIONS) return undefined;
  return readRecordedActions(steps.map((step) => (isObject(step) && step['summary'] === undefined ? { ...step, summary: inlineSummary(step) } : step)));
}

/** `tap button "Save"`, or the action's name alone when it has no target. */
function inlineSummary(step: Record<string, unknown>): string {
  const name = typeof step['name'] === 'string' ? step['name'] : 'action';
  const target = step['target'];
  const label = isObject(target) ? ` ${targetLabel(target as TraceTargetDescriptor)}` : '';
  return `${name}${label}`.slice(0, MAX_TRACE_SUMMARY_CHARS);
}

/** The actions of a trace as a call's `steps` option holds them: without the prose summaries. */
export function inlineStepsOf(trace: PinnedTrace): object[] {
  return trace.actions.map(({ summary: _summary, ...action }) => action);
}

/**
 * Why a recording cannot be pinned, or undefined when it can. A pinned step
 * never hands off, so a trace that stops at a gap (a value read off the
 * screen this run, a project tool) or that a replay could never start
 * (no start screen and no opening navigate) would fail every run.
 */
export function unpinnableReason(trace: ActionTrace): string | undefined {
  if (trace.truncated === true) return 'the recording is incomplete';
  const gap = trace.actions.find((action) => action.name === 'tool');
  if (gap !== undefined) return gap.name === 'tool' && gap.derived !== undefined ? 'the step types a value it read off the screen' : 'the step calls a project tool';
  if (trace.startPath === undefined && !opensWithNavigate(trace)) return 'the recording does not say which screen it starts on';
  return undefined;
}

/** A recording to write into a steps file, as a worker hands it to the runner. */
export interface PinWrite {
  /** The test file, project-relative with `/` separators. */
  readonly file: string;
  readonly step: PinnedStep;
  /**
   * Set when the call holds its actions in `steps`: where the call is, in
   * the test file or in a helper it calls, project-relative.
   */
  readonly inline?: { readonly file: string; readonly line: number; readonly column: number };
}

/** A step `--pin` asked for and did not pin, and why. */
export interface PinSkip {
  readonly file: string;
  readonly test: readonly string[];
  readonly instruction: string;
  readonly reason: string;
}

/** What one attempt asks the runner to pin. */
export interface AttemptPinWrites {
  readonly writes: readonly PinWrite[];
  readonly skipped: readonly PinSkip[];
}

/**
 * The parts of a trace that decide what a replay does, as canonical JSON:
 * two pins that agree here need no rewrite, so re-pinning a step whose flow
 * did not change leaves its file alone.
 */
function pinnedFlow(step: Pick<PinnedStep, 'recordedWith' | 'inline' | 'trace'>): string {
  // An inline entry's actions are the test file's; its steps file entry holds none.
  const { summary: _summary, endWaitMs: _endWaitMs, recordedBy: _recordedBy, actions, ...flow } = step.trace;
  return canonicalJson({ recordedWith: step.recordedWith, inline: step.inline === true, ...flow, actions: step.inline === true ? [] : actions });
}

/** A steps file's text: the document, two-space indented, with a final newline. */
function formatPinsDocument(steps: readonly PinnedStep[]): string {
  return `${JSON.stringify({ schemaVersion: PINS_SCHEMA_VERSION, steps: steps.map(orderedStep) }, null, 2)}\n`;
}

/** One entry with its fields in reading order: who it is, when and with what it was recorded, then the recording. */
function orderedStep(step: PinnedStep): PinnedStep {
  const trace = step.inline === true ? (({ actions: _actions, ...rest }) => rest)(step.trace) : step.trace;
  return {
    test: step.test,
    target: step.target,
    agent: step.agent,
    instruction: step.instruction,
    params: step.params,
    callIndex: step.callIndex,
    recordedAt: step.recordedAt,
    recordedWith: step.recordedWith,
    ...(step.inline === true ? { inline: true as const } : {}),
    trace: trace as PinnedTrace,
  };
}

/**
 * Merges pinned steps into one steps file: an entry for the same step is
 * replaced in place, unless it holds the same flow, and a new one is added
 * at the end; of two for one step, the later wins. Returns how many entries
 * changed. A file that exists and is not a steps document is never
 * overwritten, and the error says why.
 */
export async function mergePinsFile(file: string, steps: readonly PinnedStep[]): Promise<number> {
  const book = await loadPinsBook(file);
  if (book.status === 'unreadable') throw new Error(book.reason);
  const current: PinnedStep[] = [];
  if (book.status === 'read') {
    for (const entry of book.entries.values()) {
      // An entry no runner can replay is kept as it is only while nothing replaces it.
      if (entry.status === 'ok') current.push(entry.step);
    }
  }
  const unreadable = book.status === 'read' ? [...book.entries.values()].filter((entry) => entry.status === 'unreadable') : [];
  const positions = new Map(current.map((step, index) => [pinIdKey(step), index]));
  let changed = 0;
  for (const step of steps) {
    const key = pinIdKey(step);
    const at = positions.get(key);
    if (at === undefined) {
      positions.set(key, current.length);
      current.push(step);
      changed += 1;
    } else if (pinnedFlow(current[at]!) !== pinnedFlow(step)) {
      current[at] = step;
      changed += 1;
    }
  }
  const replaced = new Set(steps.map(pinIdKey));
  const leftUnreadable = unreadable.filter((entry) => !replaced.has(pinIdKey(entry.id)));
  if (leftUnreadable.length > 0) {
    const one = leftUnreadable.length === 1;
    throw new Error(`it holds ${one ? 'an entry' : `${String(leftUnreadable.length)} entries`} no runner can replay; re-pin ${one ? 'that step' : 'those steps'} with --pin all, or delete ${one ? 'it' : 'them'}`);
  }
  if (changed === 0 && unreadable.length === 0) return 0;
  const text = formatPinsDocument(current);
  if (Buffer.byteLength(text, 'utf8') > MAX_PINS_FILE_BYTES) throw new Error(`it would be over the ${MAX_PINS_FILE_BYTES}-byte limit`);
  await writeFileAtomic(file, text);
  return changed;
}

/** A pinned step as a recording becomes one, recorded now. */
export function pinnedStep(id: PinnedStepId, recordedWith: TraceKeyContext, trace: ActionTrace, inline: boolean): PinnedStep {
  const { recordedFor: _recordedFor, keyedBy: _keyedBy, truncated: _truncated, ...pinned } = trace;
  return { ...id, recordedAt: timestamp(), recordedWith, ...(inline ? { inline: true as const } : {}), trace: pinned };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
