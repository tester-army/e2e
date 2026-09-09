/**
 * What the built-in agent tells the model about the screen, and how much.
 *
 * The first look at a screen goes out whole. Every look after it is compared
 * with the screen the model already holds and rendered as the difference:
 * the lines that appeared, the lines that changed, the lines that went away.
 * Node ids are stable for as long as an element exists, so a line the model
 * saw earlier still names the same element, and a diff is a complete update
 * rather than a hint. A screen that changed mostly goes out whole again.
 *
 * Every full screen the transcript carries is a candidate for elision once
 * newer full screens supersede it; diffs are small and stay. That keeps the
 * conversation prefix stable turn after turn, which is what lets a provider
 * serve the resent context from its prompt cache.
 */

import type { ModelMessage } from 'ai';
import type { ExecutorObservation } from './executor.ts';

/** How many of the newest full screens stay verbatim in the transcript. */
const FULL_SCREEN_PRESERVE_COUNT = 2;

/** A diff past this many lines goes out as the full screen instead. */
const MAX_DIFF_LINES = 60;

/** A diff touching more than this share of the new screen goes out whole. */
const MAX_DIFF_SHARE = 0.5;

/** Every full screen is introduced by this phrase; the elision looks for it. */
const FULL_SCREEN_PATTERN = /Current screen \(revision /;

/** The screen as the model last received it, indexed for comparison. */
interface ShownScreen {
  readonly revision: string;
  /** Node lines in document order; the truncation marker is not a node. */
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, string>;
  readonly nodes: number;
}

/** How a screen update reads: the lead line names the action it follows. */
export interface ScreenUpdateOptions {
  /** Prose placed before the screen, such as `Tapped #n16.`. */
  readonly lead?: string | undefined;
  /**
   * Whether the update follows an action that should have changed the
   * screen. An unchanged screen is then reported as the action having had no
   * visible effect, which is what the model needs to stop repeating it.
   */
  readonly expectChange?: boolean | undefined;
}

/** Renders one step's screens for the model and remembers what it has seen. */
export class ScreenPresenter {
  private shown: ShownScreen | undefined;

  /** The step's first screen, whole. */
  initial(observation: ExecutorObservation): string {
    this.shown = indexScreen(observation);
    return renderFull(observation);
  }

  /**
   * A later screen, as the difference from the one the model holds: nothing,
   * the changed lines, or the whole screen when most of it changed.
   */
  update(observation: ExecutorObservation, options: ScreenUpdateOptions = {}): string {
    const previous = this.shown;
    const next = indexScreen(observation);
    this.shown = next;
    const lead = options.lead === undefined ? '' : `${options.lead}\n\n`;
    if (previous === undefined) return `${lead}${renderFull(observation)}`;
    const diff = diffScreens(previous, next);
    const changes = diff.length;
    if (changes === 0) {
      return `${lead}${renderUnchanged(previous.revision, observation, options.expectChange === true)}`;
    }
    if (changes >= MAX_DIFF_LINES || changes > MAX_DIFF_SHARE * next.order.length) {
      return `${lead}The screen changed substantially since revision ${previous.revision}. ${renderFull(observation)}`;
    }
    return [
      `${lead}Screen changes since revision ${previous.revision} (now revision ${observation.revision}${describeLocation(observation)}, ${String(next.nodes)} nodes): ${describeCounts(diff)}. Every node not listed as removed is still on screen under the id you have.`,
      ...diff,
      ...(observation.truncated ? ['[the new screen was truncated at the observation byte limit]'] : []),
    ].join('\n');
  }
}

/** `2 added, 1 changed, 5 removed`, omitting the kinds that did not happen. */
function describeCounts(diff: readonly string[]): string {
  const count = (kind: string): number => diff.filter((line) => line.startsWith(`${kind} `)).length;
  return (['added', 'changed', 'removed'] as const)
    .map((kind) => [count(kind), kind] as const)
    .filter(([n]) => n > 0)
    .map(([n, kind]) => `${String(n)} ${kind}`)
    .join(', ');
}

/** One full screen, headed so the elision can find it later. */
function renderFull(observation: ExecutorObservation): string {
  const nodes = indexScreen(observation).nodes;
  return `Current screen (revision ${observation.revision}${describeLocation(observation)}, ${String(nodes)} nodes):\n${observation.text}`;
}

function renderUnchanged(since: string, observation: ExecutorObservation, expectedChange: boolean): string {
  const looked = `re-observed as revision ${observation.revision}${describeLocation(observation)}`;
  return expectedChange
    ? `The screen did not change within the wait after this action (${looked}); the ids you have stay valid. If a change was expected, the control had no visible effect here: look for another way rather than repeating it.`
    : `Screen unchanged since revision ${since} (${looked}); the ids you have stay valid.`;
}

function describeLocation(observation: ExecutorObservation): string {
  return observation.path === undefined ? '' : `, path ${observation.path}`;
}

/** Node id at the head of one rendered line, or undefined for a marker line. */
function lineId(line: string): string | undefined {
  return /^\s*#(\S+)/.exec(line)?.[1];
}

/**
 * The line without its focus state. Focus moves with every action and on its
 * own, so a diff that reported it would drown the changes that matter and
 * make a control that did nothing look like it did something. The states
 * bracket is always the last token of a line. The full screen keeps focus.
 */
function withoutFocus(line: string): string {
  return line.replace(/ \[([^\]]*)\]$/, (_match, states: string) => {
    const kept = states.split(' ').filter((state) => state !== 'focused');
    return kept.length === 0 ? '' : ` [${kept.join(' ')}]`;
  });
}

function indexScreen(observation: ExecutorObservation): ShownScreen {
  const order: string[] = [];
  const byId = new Map<string, string>();
  for (const raw of observation.text.split('\n')) {
    const id = lineId(raw);
    if (id === undefined) continue;
    const line = withoutFocus(raw);
    order.push(line);
    byId.set(id, line);
  }
  return { revision: observation.revision, order, byId, nodes: byId.size };
}

/**
 * The lines that differ between two screens, keyed by node id: additions and
 * changes in the new screen's document order, then removals in the old one's.
 * A changed line is rendered whole with what it read before, so a value that
 * was typed, a state that toggled, or a label that moved reads at a glance.
 * Each line is prefixed with a word, not a symbol: a model read `- #n19
 * button "Delete"` as a button that was there and tapped it twice more.
 */
function diffScreens(previous: ShownScreen, next: ShownScreen): string[] {
  const lines: string[] = [];
  for (const line of next.order) {
    const id = lineId(line);
    if (id === undefined) continue;
    const before = previous.byId.get(id);
    if (before === undefined) {
      lines.push(`added ${line.trimStart()}`);
    } else if (before !== line) {
      lines.push(`changed ${line.trimStart()} (was: ${before.trimStart()})`);
    }
  }
  for (const line of previous.order) {
    const id = lineId(line);
    if (id !== undefined && !next.byId.has(id)) lines.push(`removed ${line.trimStart()}`);
  }
  return lines;
}

/**
 * Elides full screens the transcript no longer needs: every full screen but
 * the newest few is reduced to its lead and a notice, in the opening prompt
 * and in tool results alike. Diffs are never touched. Returns the input array
 * unchanged when nothing qualifies, so the caller can skip the override.
 */
export function compactScreenHistory(messages: ModelMessage[]): ModelMessage[] {
  const total = messages.reduce(
    (count, message) => count + screenParts(message).filter((text) => text !== undefined).length,
    0,
  );
  let stale = total - FULL_SCREEN_PRESERVE_COUNT;
  if (stale <= 0) return messages;
  return messages.map((message) => {
    if (stale <= 0) return message;
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (!FULL_SCREEN_PATTERN.test(message.content)) return message;
        stale -= 1;
        return { ...message, content: elideScreen(message.content) };
      }
      const content = message.content.map((part) => {
        if (stale <= 0 || part.type !== 'text' || !FULL_SCREEN_PATTERN.test(part.text)) return part;
        stale -= 1;
        return { ...part, text: elideScreen(part.text) };
      });
      return { ...message, content };
    }
    if (message.role !== 'tool') return message;
    const texts = screenParts(message);
    if (!texts.some((text) => text !== undefined)) return message;
    const content = message.content.map((part, index) => {
      const text = texts[index];
      if (text === undefined || stale <= 0) return part;
      stale -= 1;
      return { ...part, output: { type: 'text' as const, value: elideScreen(text) } };
    });
    return { ...message, content };
  });
}

/** Everything before the screen, then the notice in place of the tree. */
function elideScreen(text: string): string {
  const at = text.search(FULL_SCREEN_PATTERN);
  const head = at <= 0 ? (text.split('\n', 1)[0] ?? '') : text.slice(0, at).trimEnd();
  return `${head}\n[earlier screen elided; the newest "Current screen" plus the changes after it describe the screen]`;
}

/** Per-part full-screen text of one message; undefined for parts without one. */
function screenParts(message: ModelMessage): (string | undefined)[] {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return [FULL_SCREEN_PATTERN.test(message.content) ? message.content : undefined];
    }
    return message.content.map((part) =>
      part.type === 'text' && FULL_SCREEN_PATTERN.test(part.text) ? part.text : undefined,
    );
  }
  if (message.role !== 'tool') return [];
  return message.content.map((part) => {
    if (part.type !== 'tool-result') return undefined;
    const output = part.output;
    if (output.type !== 'text' || typeof output.value !== 'string') return undefined;
    return FULL_SCREEN_PATTERN.test(output.value) ? output.value : undefined;
  });
}
