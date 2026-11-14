/**
 * What the built-in agent tells the model about the screen, and how much.
 *
 * The first look at a screen goes out whole. Every look after it is compared
 * with the screen the model already holds and rendered as the difference:
 * the lines that appeared, the lines that changed, the lines that went away.
 * Node ids are stable for as long as an element exists, so a line the model
 * saw earlier still names the same element, and a diff is a complete update
 * rather than a hint. A screen that changed mostly goes out whole again,
 * with large subtrees the model already holds folded to one line each,
 * naming the revision that last listed them in full, so a persistent sidebar
 * is not repeated on every page transition. A fold line never names a
 * revision that only reported the subtree as a diff, or that itself folded
 * it: the presenter remembers, per subtree, the revision that last listed
 * it whole and what it read then.
 *
 * A screen may carry its pixels too. The presenter is where a screenshot
 * joins the text: it notes the image's size and coordinate space under the
 * screen, remembers that the model now holds pixels (from then on the step is
 * in pixel mode, and an unchanged tree under a screenshot that moved is
 * reported as that rather than as a failed action), and explains once why
 * pixels the step asked for were withheld. The transcript-side
 * elision of superseded screens and screenshots lives in
 * `transcript-compaction.ts`.
 */

import type { ToolResultPart } from 'ai';
import type { ExecutorObservation, ExecutorPixels } from './executor.ts';
import { sha256Hex } from '../internal/ids.ts';
import { interactiveNodeCount, pixelDigest } from './observation.ts';
import type { VisionDegradation } from '../run/steps.ts';

/** A diff past this many lines goes out as the full screen instead. */
const MAX_DIFF_LINES = 60;

/** A diff touching more than this share of the new screen goes out whole. */
const MAX_DIFF_SHARE = 0.5;

/** A subtree folds only when it holds at least this many nodes below its root. */
const MIN_FOLD_NODES = 10;

/** Every full screen is introduced by this phrase; the transcript elision looks for it. */
export const FULL_SCREEN_PATTERN = /Current screen \(revision /;

/** A fold line's dependency: `(12 nodes inside, unchanged since revision b1)`; the transcript elision looks for it. */
export const FOLD_DEPENDENCY_PATTERN = /\(\d+ nodes inside, unchanged since revision ([^)]+)\)/g;

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
  /** The open tabs when there was more than one, the shown one numbered from 1. */
  readonly tabs: ExecutorObservation['tabs'];
}

/** A node line whose role is the on-screen keyboard, as device trees list it. */
const KEYBOARD_LINE = /^#\S+ keyboard\b/;

/** A subtree as the model last saw it whole: the revision that listed it in full, and what it read then. */
interface FullyShownSubtree {
  readonly revision: string;
  /** SHA-256 of the subtree's node lines, focus stripped, in document order. */
  readonly digest: string;
}

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
 * The text of a tool result as the model reads it: a text result's value,
 * the message of a call the SDK refused before dispatch, or the text items
 * of a result with a screenshot attached, lead first. A structured result
 * carries none. Every reader of the transcript goes through this, so a
 * screen that arrived with pixels is never taken for no text.
 */
export function toolResultTexts(output: ToolResultPart['output']): string[] {
  if (output.type === 'text' || output.type === 'error-text') return [output.value];
  if (output.type !== 'content') return [];
  return output.value.flatMap((item) => (item.type === 'text' ? [item.text] : []));
}

/** Renders one step's screens for the model and remembers what it has seen. */
export class ScreenPresenter {
  private shown: ShownScreen | undefined;
  private screenshot: ShownScreenshot | undefined;
  private screenshotDigest: string | undefined;
  /** True once the engine said it captures no screenshots at all. */
  private pixelsDenied = false;
  /** The revision that last listed each subtree in full, by its root node id, and what it read then. */
  private fullyShown = new Map<string, FullyShownSubtree>();

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
    return this.renderWhole(observation);
  }

  /**
   * A whole screen with nothing to fold against, and the record that it
   * listed every node in full at its revision. A truncated listing records
   * nothing: nodes past the cut were never shown.
   */
  private renderWhole(observation: ExecutorObservation): string {
    const rendered = renderFull(observation);
    this.noteListed(rendered.listed, rendered.folded);
    return rendered.text;
  }

  /**
   * Records the subtrees a full render listed in full or folded, and drops
   * every other record. Called with no map by a render that listed nothing
   * in full, a diff or an unchanged screen, which only prunes: a subtree
   * the model last saw whole stays on record until a node in it leaves the
   * screen. A full render replaces the record with exactly what it showed:
   * a subtree it neither listed nor folded is not on record afterwards, so
   * a later fold can never name a screen this render did not show. A
   * truncated render lists and folds nothing, so it clears the record
   * entirely: the screens the old records named may already be elided from
   * the transcript, and a fold naming one would point at content the model
   * no longer holds.
   */
  private noteListed(listed?: ReadonlyMap<string, string>, folded?: ReadonlySet<string>): void {
    const shown = this.shown;
    if (shown === undefined) {
      this.fullyShown.clear();
      return;
    }
    if (listed === undefined) {
      for (const id of this.fullyShown.keys()) {
        if (!shown.byId.has(id)) this.fullyShown.delete(id);
      }
      return;
    }
    const next = new Map<string, FullyShownSubtree>();
    for (const id of folded ?? []) {
      const kept = this.fullyShown.get(id);
      if (kept !== undefined) next.set(id, kept);
    }
    for (const [id, digest] of listed) {
      next.set(id, { revision: shown.revision, digest });
    }
    this.fullyShown = next;
  }

  /**
   * A later screen, as the difference from the one the model holds: nothing,
   * the changed lines, or the whole screen when most of it changed.
   */
  update(observation: ExecutorObservation, options: ScreenUpdateOptions = {}): string {
    return this.render(observation, options, 'none');
  }

  /** The update, told what the screenshot going out with it says against the one the model held. */
  private render(observation: ExecutorObservation, options: ScreenUpdateOptions, pixels: PixelEvidence): string {
    let lead = options.lead === undefined ? '' : `${options.lead}\n\n`;
    if (observation.treeUnavailable === true) {
      return `${lead}${this.initial(observation)}`;
    }
    const previous = this.shown;
    const next = indexScreen(observation);
    this.shown = next;
    if (previous === undefined) return `${lead}${this.renderWhole(observation)}`;
    const closed = options.keyboardNote === false || options.lead === undefined ? '' : keyboardClosedNote(previous, next);
    const tabs = tabNote(previous.tabs, next.tabs);
    // Another tab is another document: its ids say nothing about the tab the model held.
    if (tabs?.moved === true) return `${lead}${tabs.note} ${this.renderWhole(observation)}${closed}`;
    // A tab opened is the action's effect, so an unchanged screen blames no control.
    const expectChange = options.expectChange === true && tabs === undefined;
    if (tabs !== undefined) lead = `${lead}${tabs.note} `;
    const diff = diffScreens(previous, next);
    const changes = diff.length;
    // A truncated screen is never called unchanged: what it left out is unknown.
    if (changes === 0 && !observation.truncated) {
      this.noteListed();
      return `${lead}${renderUnchanged(previous.revision, observation, expectChange, pixels)}${closed}`;
    }
    if (changes >= MAX_DIFF_LINES || changes > MAX_DIFF_SHARE * next.order.length) {
      const rendered = renderFull(observation, this.fullyShown);
      this.noteListed(rendered.listed, rendered.folded);
      return `${lead}The screen changed substantially since revision ${previous.revision}. ${rendered.text}${closed}`;
    }
    const assurance = observation.truncated
      ? 'The screen listing is truncated: nodes past the cut are not listed and none is reported removed; every listed node keeps the id you have.'
      : 'Every node not listed as removed is still on screen under the id you have.';
    this.noteListed();
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
   * screen the tree does describe, an unchanged tree after an action means
   * the control had no visible effect only when an identical screenshot says
   * so too. A moved screenshot means what changed is drawn, not listed, and
   * the model is told to read the image; with no screenshot to compare, the
   * model is told only that no listed node changed.
   */
  present(observation: ExecutorObservation, options: ScreenUpdateOptions = {}): ScreenOutput {
    const compared = this.attach(observation);
    const pixels = compared === 'none' && this.pixelsDenied ? 'unavailable' : compared;
    const text = this.render(
      observation,
      {
        ...options,
        expectChange: this.showingPixels && interactiveNodeCount(observation) === 0 ? false : options.expectChange,
      },
      pixels,
    );
    return this.withScreenshot(observation, text);
  }

  /**
   * Records that a screenshot is going to the model; from here on the step is
   * in pixel mode. Returns what it says against the screenshot the model
   * held, which is how an unchanged tree is kept from being read as no effect.
   */
  private attach(observation: ExecutorObservation): PixelEvidence {
    // Masking can be proven again on the next screen; an engine without capture never captures.
    if (observation.pixelsWithheld === 'UNSUPPORTED_CAPABILITY') this.pixelsDenied = true;
    if (observation.pixels === undefined) return 'none';
    const digest = pixelDigest(observation.pixels.data);
    const previous = this.screenshotDigest;
    this.screenshot = { pixels: observation.pixels, viewport: observation.viewport };
    this.screenshotDigest = digest;
    if (previous === undefined) return 'none';
    return digest === previous ? 'unchanged' : 'changed';
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

/** A rendered full screen, with the subtrees it listed in full and what each read, and the subtrees it folded. */
interface RenderedFullScreen {
  readonly text: string;
  /** Node ids whose subtree the rendering listed in full, each with the digest of its node lines. */
  readonly listed: ReadonlyMap<string, string>;
  /** Node ids whose subtree the rendering folded, keeping the record of the revision that last listed it in full. */
  readonly folded: ReadonlySet<string>;
}

/** One full screen, headed so the elision can find it later. A screen that
 * follows one the model holds folds its large unchanged subtrees: the root
 * line stays, with the count of the nodes inside and the revision that last
 * listed them in full, and the nodes inside are left out. The first screen of a
 * step has nothing to fold against, and a truncated listing never folds,
 * since the nodes past the cut are unknown. */
function renderFull(
  observation: ExecutorObservation,
  fullyShown?: ReadonlyMap<string, FullyShownSubtree>,
): RenderedFullScreen {
  if (observation.treeUnavailable === true) {
    return {
      text: `Current screen (revision ${observation.revision}${describeLocation(observation)}, semantic capture unavailable):\n${observation.text}`,
      listed: new Map(),
      folded: new Set(),
    };
  }
  const nodes = indexScreen(observation).nodes;
  const head = `Current screen (revision ${observation.revision}${describeLocation(observation)}, ${String(nodes)} nodes):\n`;
  if (fullyShown === undefined || observation.truncated) {
    const entries = treeEntries(observation);
    return {
      text: `${head}${observation.text}`,
      listed: observation.truncated ? new Map() : subtreeDigests(entries, spanEnds(entries)),
      folded: new Set(),
    };
  }
  const folded = foldUnchangedSubtrees(observation, fullyShown);
  return { text: `${head}${folded.text}`, listed: folded.listed, folded: folded.folded };
}

/** A node line of a screen listing, with its depth and id. */
interface TreeEntry {
  readonly raw: string;
  readonly indent: number;
  readonly id: string | undefined;
}

/** A screen listing split into lines, each with its depth and node id. */
function treeEntries(observation: ExecutorObservation): TreeEntry[] {
  return observation.text.split('\n').map((raw) => ({
    raw,
    indent: indentOf(raw),
    id: lineId(raw),
  }));
}

/**
 * The end of every node's span: the first line after it that is not one of
 * its descendants, a marker line with no node id or a line at its depth or
 * above. A marker line closes every open span: no subtree reaches past one.
 */
function spanEnds(entries: readonly TreeEntry[]): number[] {
  const ends = Array.from({ length: entries.length }, () => entries.length);
  const open: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.id === undefined) {
      while (open.length > 0) ends[open.pop()!] = index;
      continue;
    }
    while (open.length > 0 && entries[open[open.length - 1]!]!.indent >= entry.indent) {
      ends[open.pop()!] = index;
    }
    open.push(index);
  }
  return ends;
}

/**
 * The digest of every subtree large enough to fold: its node lines, focus
 * stripped and unindented, in document order. Focus moves with every action,
 * so it is left out the way the fold's own comparison leaves it out. Lines
 * are joined with a separator no node line carries, so two different subtrees
 * cannot digest alike by regrouping lines. A smaller subtree never folds, so
 * it needs no digest: it is listed in full whenever a screen goes out whole,
 * which puts it on record at that revision if it later grows large enough.
 */
function subtreeDigests(entries: readonly TreeEntry[], ends: readonly number[]): Map<string, string> {
  const digests = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.id === undefined) continue;
    if (ends[index]! - index - 1 < MIN_FOLD_NODES) continue;
    const lines: string[] = [];
    for (let inner = index; inner < ends[index]!; inner += 1) {
      lines.push(withoutFocus(entries[inner]!.raw).trimStart());
    }
    digests.set(entry.id, sha256Hex(lines.join('\n')));
  }
  return digests;
}

/** Leading spaces of one listing line: its depth in the tree. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** True when the line's state bracket names the focused node. */
function hasFocus(line: string): boolean {
  const bracket = stateBracket(line);
  return bracket !== undefined && bracket.states.split(' ').includes('focused');
}

/**
 * The trailing state bracket of a line, with the line before it, or
 * undefined when the line carries none. The states bracket is always the
 * last token of a line.
 */
function stateBracket(line: string): { readonly states: string; readonly before: string } | undefined {
  const match = / \[([^\]]*)\]$/.exec(line);
  return match === null ? undefined : { states: match[1]!, before: line.slice(0, match.index) };
}

/**
 * The screen listing with every large unchanged subtree replaced by its root
 * line plus a summary, and the subtrees the listing left in full. A subtree
 * folds only when it is not the document root, holds enough nodes to be
 * worth the hiding, carries no focused node, and still reads as it did at
 * the revision the fold line names: the digest covers its node ids and lines,
 * so no comparison with the screen before it is needed. A change update in
 * between may have listed it only in part, or an earlier screen may itself
 * have folded it, so the last observation's revision is no proof the model
 * holds it whole. A subtree that fails the digest check is listed in full
 * instead, which puts it on record at this revision.
 */
function foldUnchangedSubtrees(
  observation: ExecutorObservation,
  fullyShown: ReadonlyMap<string, FullyShownSubtree>,
): { readonly text: string; readonly listed: ReadonlyMap<string, string>; readonly folded: ReadonlySet<string> } {
  const entries = treeEntries(observation);
  const ends = spanEnds(entries);
  const digests = subtreeDigests(entries, ends);
  const foldedSpans: Array<{ readonly start: number; readonly end: number }> = [];
  const foldedIds = new Set<string>();
  const out: string[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.id === undefined) {
      out.push(entry.raw);
      index += 1;
      continue;
    }
    const end = ends[index]!;
    const inside = end - index - 1;
    const shown = fullyShown.get(entry.id);
    if (
      index > 0 && entry.indent > 0 && inside >= MIN_FOLD_NODES &&
      shown !== undefined && digests.get(entry.id) === shown.digest &&
      !subtreeHoldsFocus(entries, index, end)
    ) {
      out.push(`${entry.raw} (${String(inside)} nodes inside, unchanged since revision ${shown.revision})`);
      foldedSpans.push({ start: index, end });
      foldedIds.add(entry.id);
      index = end;
    } else {
      out.push(entry.raw);
      index += 1;
    }
  }
  return { text: out.join('\n'), listed: fullyListedSubtrees(entries, ends, digests, foldedSpans), folded: foldedIds };
}

/** True when a node in the span holds focus: the fold would hide where focus is. */
function subtreeHoldsFocus(entries: readonly TreeEntry[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (hasFocus(entries[index]!.raw)) return true;
  }
  return false;
}

/**
 * The subtrees a folded listing left in full: every node whose span holds no
 * line a fold hid. A folded root's own span is not fully listed, its hidden
 * nodes are not, and neither is a subtree holding a folded one: the fold
 * line it would name later has to be a screen that showed all of it.
 */
function fullyListedSubtrees(
  entries: readonly TreeEntry[],
  ends: readonly number[],
  digests: ReadonlyMap<string, string>,
  foldedSpans: readonly { readonly start: number; readonly end: number }[],
): ReadonlyMap<string, string> {
  const hidden = Array.from({ length: entries.length }, () => 0);
  for (const span of foldedSpans) {
    for (let index = span.start + 1; index < span.end; index += 1) hidden[index] = 1;
  }
  const prefix = Array.from({ length: entries.length + 1 }, () => 0);
  for (let index = 0; index < entries.length; index += 1) prefix[index + 1] = prefix[index]! + hidden[index]!;
  const listed = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.id === undefined) continue;
    if (prefix[ends[index]!]! - prefix[index]! !== 0) continue;
    const digest = digests.get(entry.id);
    if (digest === undefined) continue;
    listed.set(entry.id, digest);
  }
  return listed;
}

/**
 * What the screenshot going out with an update says against the one the
 * model held: `none` when there is no pair to compare (no screenshot, or the
 * step's first), `unavailable` when the step can get no screenshot at all.
 */
type PixelEvidence = 'changed' | 'unchanged' | 'none' | 'unavailable';

/**
 * An update with no listed line changed. A screenshot that moved while the
 * listing stood still is said so, whatever was expected: the effect is drawn,
 * and blaming the control would send the model looking for another way to do
 * what it just did. For the same reason the control is blamed only when an
 * identical screenshot backs the tree: the tree alone cannot tell a drawn
 * effect (a filled dot, a color) from none.
 */
function renderUnchanged(since: string, observation: ExecutorObservation, expectedChange: boolean, pixels: PixelEvidence): string {
  const looked = `re-observed as revision ${observation.revision}${describeLocation(observation)}`;
  if (pixels === 'changed') {
    return `Since revision ${since} (${looked}): listed nodes unchanged; the screenshot changed. Read the effect off the image (a focus ring alone is no effect); the ids you have stay valid.`;
  }
  if (!expectedChange) return `Screen unchanged since revision ${since} (${looked}); the ids you have stay valid.`;
  switch (pixels) {
    case 'unchanged':
      return `The screen did not change within the wait after this action (${looked}); the ids you have stay valid. If a change was expected, the control had no visible effect here: look for another way rather than repeating it.`;
    case 'unavailable':
      return `No listed node changed within the wait after this action (${looked}); the ids you have stay valid. No screenshot can be taken in this step, so the listing is the only evidence: if a change was expected, look for another way rather than repeating it.`;
    case 'none':
      return `No listed node changed within the wait after this action (${looked}); the ids you have stay valid. The listing shows only what the tree describes: a drawn change needs a screenshot to see.`;
  }
}

/** The keyboard note when the action took the keyboard off the screen. */
function keyboardClosedNote(previous: ShownScreen, next: ShownScreen): string {
  // A truncated listing may have cut the keyboard off, not closed it.
  if (!previous.keyboard || next.keyboard || next.truncated) return '';
  return `\n\n${KEYBOARD_CLOSED_NOTE}`;
}

function describeLocation(observation: ExecutorObservation): string {
  const path = observation.path === undefined ? '' : `, path ${observation.path}`;
  const tabs = observation.tabs === undefined ? '' : `, tab ${String(observation.tabs.active)} of ${String(observation.tabs.count)}`;
  return `${path}${tabs}`;
}

/**
 * What the model hears when the open tabs changed, or undefined when they
 * did not. A tab the app opens joins at the end and stays in the
 * background, so the screen is on the same tab (`moved` false). Any other
 * change may have put the screen on another tab (`moved` true): one that
 * closed hands the screen back to another.
 */
function tabNote(previous: ShownScreen['tabs'], next: ShownScreen['tabs']): { readonly note: string; readonly moved: boolean } | undefined {
  const before = previous ?? { count: 1, active: 1 };
  const after = next ?? { count: 1, active: 1 };
  if (before.count === after.count && before.active === after.active) return undefined;
  if (after.count > before.count && after.active === before.active) {
    const added = after.count - before.count;
    const total = String(after.count);
    const opened = added === 1
      ? `a new tab (tab ${total} of ${total})`
      : `${String(added)} new tabs (tabs ${String(before.count + 1)} to ${total} of ${total})`;
    return { note: `The app opened ${opened}. The screen still shows tab ${String(after.active)}; use switch_tab to see ${added === 1 ? 'it' : 'one'}.`, moved: false };
  }
  if (next === undefined) return { note: `The other tab${before.count > 2 ? 's' : ''} closed; the screen shows the one tab still open.`, moved: true };
  return { note: `The screen shows tab ${String(after.active)} of ${String(after.count)} now.`, moved: true };
}

/** Node id at the head of one rendered line, or undefined for a marker line. */
function lineId(line: string): string | undefined {
  return /^\s*#(\S+)/.exec(line)?.[1];
}

/**
 * The node lines with focus stripped. Focus moves with every action and on its
 * own, so a diff that reported it would drown the changes that matter and
 * make a control that did nothing look like it did something. The full screen keeps focus.
 */
function withoutFocus(line: string): string {
  const bracket = stateBracket(line);
  if (bracket === undefined) return line;
  const kept = bracket.states.split(' ').filter((state) => state !== 'focused');
  return kept.length === 0 ? bracket.before : `${bracket.before} [${kept.join(' ')}]`;
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
    tabs: observation.tabs,
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
