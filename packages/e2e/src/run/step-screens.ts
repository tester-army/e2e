/**
 * How the screen changed from one step to the next, for the trace. Each step
 * keeps the last screen it saw (an observation, or a screen the engine
 * handed over), compared with the last screen of the step before that saw
 * one. Lines are compared without their node ids: a device engine mints new
 * ids on every capture, so only the text says whether a node stayed. Where
 * one id names a node on both screens (a browser keeps them), a node whose
 * text moved reads as changed rather than as removed and added.
 */

import { describeNode, redactNode, type RedactedNode } from '../agent/observation.ts';
import { bound } from '../internal/text.ts';
import type { Observation } from '../engine/surface.ts';
import type { SessionSecrecy } from './secrecy.ts';

/** Change lines a step keeps; the rest are counted. */
const MAX_SCREEN_CHANGES = 12;
/** Characters of one change line. */
const MAX_CHANGE_CHARS = 200;

/** One node of a screen as the trace compares it: the engine's id, and the node as a line describes it, without the id or focus. */
interface ScreenLine {
  readonly id: string;
  readonly text: string;
}

/** One screen as the trace keeps it: where it was, and its nodes in screen order. */
export interface ScreenText {
  readonly location?: string | undefined;
  readonly lines: readonly ScreenLine[];
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

/** The step's screen against the one `since` saw, or as the first screen when there was none. */
export function compareScreens(previous: { readonly step: number; readonly screen: ScreenText } | undefined, next: ScreenText): StepScreen {
  const after = next.lines;
  const head = { ...(next.location === undefined ? {} : { location: next.location }), nodes: after.length };
  if (previous === undefined) return { ...head, changes: [] };
  const before = previous.screen.lines;
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
  const beforeById = new Map(before.map((line) => [line.id, line] as const));
  const paired = new Set<ScreenLine>();
  const changed = new Map<ScreenLine, ScreenLine>();
  for (const line of after) {
    const old = beforeById.get(line.id);
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
    if (beforeById.has(line.id)) continue;
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

/** States a reader comparing two screens does not count as a change: focus moves with every action. */
const UNCOMPARED_STATES: ReadonlySet<string> = new Set(['focused']);

/**
 * One observation as the trace keeps it: every node redacted the way the
 * screen at failure is, then described the way its line reads, in screen
 * order, up to `maxBytes` of text; undefined for a screen with no tree.
 */
export function traceScreen(observation: Observation, options: TraceScreenOptions): ScreenText | undefined {
  if (observation.kind !== 'semantic') return undefined;
  const { redact, redactCut } = options.secrecy.ledger;
  const lines: ScreenLine[] = [];
  let bytes = 0;
  const walk = (node: RedactedNode): boolean => {
    const text = describeNode(node, options.appOrigin, UNCOMPARED_STATES);
    bytes += Buffer.byteLength(text, 'utf8') + 1;
    if (lines.length > 0 && bytes > options.maxBytes) return false;
    lines.push({ id: node.ref.id, text });
    return (node.children ?? []).every(walk);
  };
  walk(redactNode(observation.tree, { redact, redactCut }));
  return { location: observation.location === undefined ? undefined : redact(observation.location), lines };
}
