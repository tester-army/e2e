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
 * A screen may carry its pixels too. The presenter is where a screenshot
 * joins the text: it notes the image's size and coordinate space under the
 * screen, remembers that the model now holds pixels (from then on the step is
 * in pixel mode and an unchanged tree is not a failed action), and explains
 * once why pixels the step asked for were withheld. The transcript-side
 * elision of superseded screens and screenshots lives in
 * `transcript-compaction.ts`.
 */

import type { ToolResultPart } from 'ai';
import type { ExecutorObservation, ExecutorPixels } from './executor.ts';
import { interactiveNodeCount } from './observation.ts';
import type { VisionDegradation } from '../run/steps.ts';

/** A diff past this many lines goes out as the full screen instead. */
const MAX_DIFF_LINES = 60;

/** A diff touching more than this share of the new screen goes out whole. */
const MAX_DIFF_SHARE = 0.5;

/** Every full screen is introduced by this phrase; the transcript elision looks for it. */
export const FULL_SCREEN_PATTERN = /Current screen \(revision /;

/** The screen as the model last received it, indexed for comparison. */
interface ShownScreen {
  readonly revision: string;
  /** Node lines in document order, without indentation or focus; the truncation marker is not a node. */
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, string>;
  readonly nodes: number;
  /** The listing is cut short (byte limit or engine cap): nodes beyond it exist but are not listed. */
  readonly truncated: boolean;
  /** An on-screen keyboard is among the nodes. */
  readonly keyboard: boolean;
}

/** A node line whose role is the on-screen keyboard, as device trees list it. */
const KEYBOARD_LINE = /^#\S+ keyboard\b/;

/**
 * What the model needs to hear when an action closed the keyboard: on a
 * touch screen the tap that closes it is often spent on closing it, so the
 * control under the finger may not have reacted.
 */
const KEYBOARD_CLOSED_NOTE =
  'The on-screen keyboard closed with this action. On a touch screen a tap made while the keyboard is up can be spent on closing it: if the control you acted on shows no effect above, act on it again now that the keyboard is down.';

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
  /**
   * Whether an on-screen keyboard leaving with the action is pointed out,
   * since on a touch screen the tap that closes it may have done nothing
   * else. Default on; off for the dismissal whose whole point that was, and
   * for a plain look, which acted on nothing.
   */
  readonly keyboardNote?: boolean | undefined;
}

/** The screenshot the model holds newest, and the viewport it was taken of. */
export interface ShownScreenshot {
  readonly pixels: ExecutorPixels;
  readonly viewport: ExecutorObservation['viewport'];
}

/**
 * A rendered screen: text alone, or text with the screenshot the model
 * receives alongside it. The image rides the tool result (or the opening
 * prompt) itself, so the model sees what its action did rather than a
 * description of it.
 */
export type ScreenOutput = string | { readonly text: string; readonly pixels: ExecutorPixels };

/** True for a rendered screen that carries its screenshot. */
export function isScreenOutput(value: unknown): value is Exclude<ScreenOutput, string> {
  return typeof value === 'object' && value !== null && 'text' in value && 'pixels' in value;
}

/**
 * The text of a tool result as the model reads it: a text result's value, or
 * the text items of a result with a screenshot attached, lead first. A
 * structured result carries none. Every reader of the transcript goes through
 * this, so a screen that arrived with pixels is never taken for no text.
 */
export function toolResultTexts(output: ToolResultPart['output']): string[] {
  if (output.type === 'text') return [output.value];
  if (output.type !== 'content') return [];
  return output.value.flatMap((item) => (item.type === 'text' ? [item.text] : []));
}

/** Renders one step's screens for the model and remembers what it has seen. */
export class ScreenPresenter {
  private shown: ShownScreen | undefined;
  private screenshot: ShownScreenshot | undefined;

  /** True once a screenshot went to the model in this step. */
  get showingPixels(): boolean {
    return this.screenshot !== undefined;
  }

  /** The newest screenshot the model holds; the coordinate space of `tap_at`. */
  get latestScreenshot(): ShownScreenshot | undefined {
    return this.screenshot;
  }

  /** The step's first screen, whole. */
  initial(observation: ExecutorObservation): string {
    this.shown = observation.treeUnavailable === true ? undefined : indexScreen(observation);
    return renderFull(observation);
  }

  /**
   * A later screen, as the difference from the one the model holds: nothing,
   * the changed lines, or the whole screen when most of it changed.
   */
  update(observation: ExecutorObservation, options: ScreenUpdateOptions = {}): string {
    const lead = options.lead === undefined ? '' : `${options.lead}\n\n`;
    if (observation.treeUnavailable === true) {
      return `${lead}${this.initial(observation)}`;
    }
    const previous = this.shown;
    const next = indexScreen(observation);
    this.shown = next;
    if (previous === undefined) return `${lead}${renderFull(observation)}`;
    const closed = options.keyboardNote === false || options.lead === undefined ? '' : keyboardClosedNote(previous, next);
    const diff = diffScreens(previous, next);
    const changes = diff.length;
    // A truncated screen is never called unchanged: what it left out is unknown.
    if (changes === 0 && !observation.truncated) {
      return `${lead}${renderUnchanged(previous.revision, observation, options.expectChange === true)}${closed}`;
    }
    if (changes >= MAX_DIFF_LINES || changes > MAX_DIFF_SHARE * next.order.length) {
      return `${lead}The screen changed substantially since revision ${previous.revision}. ${renderFull(observation)}${closed}`;
    }
    const assurance = observation.truncated
      ? 'The screen listing is truncated: nodes past the cut are not listed and none is reported removed; every listed node keeps the id you have.'
      : 'Every node not listed as removed is still on screen under the id you have.';
    return [
      `${lead}Screen changes since revision ${previous.revision} (now revision ${observation.revision}${describeLocation(observation)}, ${String(next.nodes)} nodes): ${describeCounts(diff)}. ${assurance}`,
      ...diff,
    ].join('\n') + closed;
  }

  /** The step's first screen, whole, with its screenshot when the observation carries one. */
  open(observation: ExecutorObservation): ScreenOutput {
    this.attach(observation);
    return this.withScreenshot(observation, this.initial(observation));
  }

  /**
   * A later screen as the model reads it: the changes since the screen it
   * holds and, once the step is showing pixels, the screenshot too. On a
   * screen the tree cannot describe (nothing interactive listed) an unchanged
   * tree is not a failed action: what the action did may be drawn, not
   * listed, so the screenshot is the evidence and no action is blamed. On a
   * screen the tree does describe, an unchanged tree after an action still
   * means the control had no visible effect, pixels or not.
   */
  present(observation: ExecutorObservation, options: ScreenUpdateOptions = {}): ScreenOutput {
    this.attach(observation);
    const text = this.update(observation, {
      ...options,
      expectChange: this.showingPixels && interactiveNodeCount(observation) === 0 ? false : options.expectChange,
    });
    return this.withScreenshot(observation, text);
  }

  /** Records that a screenshot is going to the model; from here on the step is in pixel mode. */
  private attach(observation: ExecutorObservation): void {
    if (observation.pixels === undefined) return;
    this.screenshot = { pixels: observation.pixels, viewport: observation.viewport };
  }

  /**
   * The rendered screen with its screenshot and the coordinate note, or with
   * the reason the pixels the step asked for did not come, or as is when no
   * pixels were asked for.
   */
  private withScreenshot(observation: ExecutorObservation, text: string): ScreenOutput {
    const { pixels } = observation;
    if (pixels !== undefined) return { text: `${text}\n\n${screenshotNote(pixels)}`, pixels };
    if (observation.pixelsWithheld === undefined) return text;
    return `${text}\n\nNo screenshot: ${withheldAdvice(observation.pixelsWithheld)}`;
  }
}

/** The line under a screenshot: its pixel size and the coordinate space the point verbs read. */
function screenshotNote(pixels: Pick<ExecutorPixels, 'width' | 'height' | 'scale'>): string {
  return `Screenshot attached: ${String(pixels.width)} by ${String(pixels.height)} pixels${
    pixels.scale === 1 ? '' : ` (${String(pixels.scale)} per CSS pixel)`
  }. Point coordinates (tap_at and the other _at verbs) are pixels of this image: x from the left edge, y from the top edge.`;
}

/** Why pixels did not reach the model, and what to do instead. */
function withheldAdvice(code: VisionDegradation): string {
  switch (code) {
    case 'PIXEL_TAINTED':
      return 'a secret was filled in this attempt, so no pixels leave the runner until it ends (PIXEL_TAINTED). Work from the tree and tap listed nodes by id.';
    case 'MASKING_UNPROVEN':
      return 'the engine could not prove every secure field on screen masked (MASKING_UNPROVEN). Work from the tree and tap listed nodes by id.';
    case 'UNSUPPORTED_CAPABILITY':
      return 'this engine captures no pixels (UNSUPPORTED_CAPABILITY). Work from the tree and tap listed nodes by id.';
  }
}

/** `2 added, 1 changed, 5 removed`, omitting the kinds that did not happen. */
function describeCounts(diff: readonly string[]): string {
  const count = (kind: string): number => diff.filter((line) => line.startsWith(`${kind} `)).length;
  const counts = (['added', 'changed', 'removed'] as const)
    .map((kind) => [count(kind), kind] as const)
    .filter(([n]) => n > 0)
    .map(([n, kind]) => `${String(n)} ${kind}`)
    .join(', ');
  return counts === '' ? 'no listed node changed' : counts;
}

/** One full screen, headed so the elision can find it later. */
function renderFull(observation: ExecutorObservation): string {
  if (observation.treeUnavailable === true) {
    return `Current screen (revision ${observation.revision}${describeLocation(observation)}, semantic capture unavailable):\n${observation.text}`;
  }
  const nodes = indexScreen(observation).nodes;
  return `Current screen (revision ${observation.revision}${describeLocation(observation)}, ${String(nodes)} nodes):\n${observation.text}`;
}

function renderUnchanged(since: string, observation: ExecutorObservation, expectedChange: boolean): string {
  const looked = `re-observed as revision ${observation.revision}${describeLocation(observation)}`;
  return expectedChange
    ? `The screen did not change within the wait after this action (${looked}); the ids you have stay valid. If a change was expected, the control had no visible effect here: look for another way rather than repeating it.`
    : `Screen unchanged since revision ${since} (${looked}); the ids you have stay valid.`;
}

/** The keyboard note when the action took the keyboard off the screen. */
function keyboardClosedNote(previous: ShownScreen, next: ShownScreen): string {
  // A truncated listing may have cut the keyboard off, not closed it.
  if (!previous.keyboard || next.keyboard || next.truncated) return '';
  return `\n\n${KEYBOARD_CLOSED_NOTE}`;
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
    // Without indentation: a node that only moved to another depth reads the
    // same, and reporting it as changed would show identical text twice.
    const line = withoutFocus(raw).trimStart();
    order.push(line);
    byId.set(id, line);
  }
  return {
    revision: observation.revision,
    order,
    byId,
    nodes: byId.size,
    truncated: observation.truncated,
    keyboard: order.some((line) => KEYBOARD_LINE.test(line)),
  };
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
      lines.push(`added ${line}`);
    } else if (before !== line) {
      lines.push(`changed ${line} (was: ${before})`);
    }
  }
  // A truncated screen stopped listing nodes before the end; the ones it
  // left out may well still exist, so nothing is called removed on its word.
  if (next.truncated) return lines;
  for (const line of previous.order) {
    const id = lineId(line);
    if (id !== undefined && !next.byId.has(id)) lines.push(`removed ${line}`);
  }
  return lines;
}
