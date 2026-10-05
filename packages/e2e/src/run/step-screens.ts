/**
 * How the screen changed from one step to the next, for the trace. Each step
 * keeps the last screen it saw (an observation, or a screen the engine
 * handed over), compared with the last screen of the step before that saw
 * one. Lines are compared without their node ids: a device engine mints new
 * ids on every capture, so only the text says whether a node stayed. Where
 * one id names a node on both screens (a browser keeps them), a node whose
 * text moved reads as changed rather than as removed and added.
 */

import { prepareObservation } from '../agent/observation.ts';
import { bound } from '../cache/trace.ts';
import type { Observation } from '../engine/surface.ts';
import type { SessionSecrecy } from './secrecy.ts';

/** Change lines a step keeps; the rest are counted. */
const MAX_SCREEN_CHANGES = 12;
/** Characters of one change line. */
const MAX_CHANGE_CHARS = 200;

/** One screen as the trace reads it: where it was, and its node lines as listed. */
export interface ScreenText {
  readonly location?: string | undefined;
  /** The listing, one node per line, as `prepareObservation` renders it. */
  readonly text: string;
}

/** How the screen a step saw differs from the one before it. */
export interface StepScreen {
  /** Where the screen was, as the engine says: a URL, an app. */
  location?: string;
  /** Nodes the screen listed. */
  nodes: number;
  /** The step whose screen this one is compared with; absent for the first screen of the attempt. */
  since?: number;
  /** `added`, `removed`, and `changed` node lines, without node ids, in screen order; empty when nothing changed. */
  changes: string[];
  /** Change lines past `changes`. */
  more?: number;
}

interface ScreenLine {
  readonly id: string | undefined;
  readonly text: string;
}

/** `#n27 textbox "New todo" [focused]` as `{ id: 'n27', text: 'textbox "New todo"' }`; focus moves with every action and is left out. */
function screenLines(text: string): ScreenLine[] {
  const lines: ScreenLine[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s*#(\S+) (.*)$/u.exec(raw);
    if (match === null) continue;
    lines.push({ id: match[1], text: match[2]!.replace(/ \[focused\]$/u, '').replace(/\bfocused, |, focused\b/u, '') });
  }
  return lines;
}

/** The step's screen against the one `since` saw, or as the first screen when there was none. */
export function compareScreens(previous: { readonly step: number; readonly screen: ScreenText } | undefined, next: ScreenText): StepScreen {
  const after = screenLines(next.text);
  const head = { ...(next.location === undefined ? {} : { location: next.location }), nodes: after.length };
  if (previous === undefined) return { ...head, changes: [] };
  const before = screenLines(previous.screen.text);
  const changes = diffLines(before, after);
  return {
    ...head,
    since: previous.step,
    changes: changes.slice(0, MAX_SCREEN_CHANGES).map((line) => bound(line, MAX_CHANGE_CHARS)),
    ...(changes.length > MAX_SCREEN_CHANGES ? { more: changes.length - MAX_SCREEN_CHANGES } : {}),
  };
}

/**
 * The lines that differ: a node one id names on both screens with other text
 * is changed; past those, text is counted, so a line the new screen lists
 * more often than the old is added, and one it lists less often is removed.
 */
function diffLines(before: readonly ScreenLine[], after: readonly ScreenLine[]): string[] {
  const beforeById = new Map(before.flatMap((line) => (line.id === undefined ? [] : [[line.id, line] as const])));
  const paired = new Set<ScreenLine>();
  const changed = new Map<ScreenLine, ScreenLine>();
  for (const line of after) {
    const old = line.id === undefined ? undefined : beforeById.get(line.id);
    if (old === undefined) continue;
    paired.add(old);
    if (old.text !== line.text) changed.set(line, old);
  }
  const remaining = new Map<string, number>();
  for (const line of before) {
    if (!paired.has(line)) remaining.set(line.text, (remaining.get(line.text) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const line of after) {
    const old = changed.get(line);
    if (old !== undefined) {
      lines.push(`changed ${line.text} (was: ${old.text})`);
      continue;
    }
    if (line.id !== undefined && beforeById.has(line.id)) continue;
    const left = remaining.get(line.text) ?? 0;
    if (left > 0) remaining.set(line.text, left - 1);
    else lines.push(`added ${line.text}`);
  }
  for (const line of before) {
    if (paired.has(line)) continue;
    const left = remaining.get(line.text) ?? 0;
    if (left === 0) continue;
    remaining.set(line.text, left - 1);
    lines.push(`removed ${line.text}`);
  }
  return lines;
}

/** What `traceScreen` redacts with and bounds by. */
export interface TraceScreenOptions {
  readonly secrecy: SessionSecrecy;
  readonly maxBytes: number;
  /** The app base URL's origin, whose link targets the screen lists as paths. */
  readonly appOrigin: string | undefined;
}

/** One observation as the trace keeps it, redacted the way the screen at failure is; undefined for a screen with no tree. */
export function traceScreen(observation: Observation, options: TraceScreenOptions): ScreenText | undefined {
  if (observation.kind !== 'semantic') return undefined;
  const { redact, redactCut } = options.secrecy.ledger;
  const prepared = prepareObservation(observation, { redact, redactCut, maxBytes: options.maxBytes, appOrigin: options.appOrigin });
  return { location: prepared.location, text: prepared.text };
}
