/**
 * What the model no longer needs to re-read, elided from the transcript.
 *
 * Every full screen and every screenshot the transcript carries is a
 * candidate for elision once newer ones supersede it; change updates are
 * small and stay. Rewriting an earlier message changes the request prefix,
 * and the provider's prompt cache serves only an unchanged prefix, so stale
 * parts are tolerated up to a budget and then elided in one batch rather
 * than one rewrite per turn. Both elisions walk the transcript the same way:
 * oldest part first, across the opening prompt and tool results alike.
 */

import type { FilePart, ModelMessage, TextPart, ToolResultPart, UserContent } from 'ai';
import { FULL_SCREEN_PATTERN, toolResultTexts } from './screen-update.ts';

/** A part of a user message; a string message counts as one text part. */
type UserPart = Exclude<UserContent, string>[number];
/** A part of a tool message. */
type ToolPart = Extract<ModelMessage, { role: 'tool' }>['content'][number];
/** An item of a tool result with a screenshot attached: its text, or the image. */
type ContentItem = Extract<ToolResultPart['output'], { type: 'content' }>['value'][number];

/**
 * A rewrite of one part. Returning undefined declines the part; a returned
 * part replaces it and counts against the elision budget. A tool result is
 * rewritten whole: it carries at most one screen or one screenshot.
 */
interface PartRewrite {
  readonly user: (part: UserPart) => UserPart | undefined;
  readonly tool: (part: ToolPart) => ToolPart | undefined;
}

/** The parts of user and tool messages in transcript order; other roles carry nothing to elide. */
function transcriptParts(messages: readonly ModelMessage[]): (UserPart | ToolPart)[] {
  const parts: (UserPart | ToolPart)[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      parts.push(...(typeof message.content === 'string' ? [asTextPart(message.content)] : message.content));
    } else if (message.role === 'tool') {
      parts.push(...message.content);
    }
  }
  return parts;
}

function asTextPart(text: string): TextPart {
  return { type: 'text', text };
}

/**
 * Rewrites the oldest `count` parts the rewrite accepts and leaves every other
 * message untouched, by identity, so a caller can tell whether anything
 * changed. A string user message is rewritten as a string.
 */
function rewriteOldestParts(messages: ModelMessage[], count: number, rewrite: PartRewrite): ModelMessage[] {
  let remaining = count;
  const rewriteAll = <P>(parts: readonly P[], one: (part: P) => P | undefined): P[] | undefined => {
    let changed = false;
    const next = parts.map((part) => {
      if (remaining <= 0) return part;
      const replaced = one(part);
      if (replaced === undefined) return part;
      remaining -= 1;
      changed = true;
      return replaced;
    });
    return changed ? next : undefined;
  };
  return messages.map((message) => {
    if (remaining <= 0) return message;
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        const [part] = rewriteAll([asTextPart(message.content)], rewrite.user) ?? [];
        return part?.type === 'text' ? { ...message, content: part.text } : message;
      }
      const content = rewriteAll(message.content, rewrite.user);
      return content === undefined ? message : { ...message, content };
    }
    if (message.role !== 'tool') return message;
    const content = rewriteAll(message.content, rewrite.tool);
    return content === undefined ? message : { ...message, content };
  });
}

/**
 * How many of the newest full screens stay verbatim in the transcript. One:
 * a whole new screen means the page changed mostly, and the screen it
 * replaced is dead weight on every later turn. Change updates never elide.
 * A screen a surviving screen's fold lines depend on stays too: a folded
 * line names the revision that last listed its subtree in full, and that
 * screen is the only place the model can still read it.
 */
const FULL_SCREEN_PRESERVE_COUNT = 1;

/** A fold line's dependency: `(12 nodes inside, unchanged since revision b1)`. */
const FOLD_DEPENDENCY_PATTERN = /\(\d+ nodes inside, unchanged since revision ([^)]+)\)/g;

/** The revision a full screen's heading carries, or undefined when it carries none. */
function screenRevision(text: string): string | undefined {
  return /Current screen \(revision ([^,)]+),/.exec(text)?.[1];
}

/** The revisions a full screen's fold lines depend on. */
function foldDependencies(text: string): string[] {
  return [...text.matchAll(FOLD_DEPENDENCY_PATTERN)].map((match) => match[1]!);
}

/**
 * Bytes of superseded full screens a transcript carries before they are
 * elided. Re-reading a stale screen from the cache costs a tenth of sending
 * its replacement, so one that still fits under this budget stays verbatim.
 * A two-turn step never elides.
 */
const KEEP_STALE_SCREEN_BYTES = 32 * 1024;

export interface CompactScreenHistoryOptions {
  /** Stale full-screen bytes tolerated before elision; defaults to the cache-friendly budget. */
  readonly keepStaleBytes?: number;
}

/**
 * Elides full screens the transcript no longer needs: every full screen but
 * the newest is reduced to its lead and a notice, in the opening prompt
 * and in tool results alike, once the screens that may be elided together
 * outgrow the budget. Diffs are never touched. A screen a surviving screen's
 * fold lines depend on is never elided, with the screens it in turn depends
 * on: the fold line names the revision that last listed its subtree in full,
 * and eliding it would leave the model a pointer to content it no longer
 * holds. Returns the input array unchanged when nothing qualifies, so the
 * caller can skip the override.
 */
export function compactScreenHistory(
  messages: ModelMessage[],
  options: CompactScreenHistoryOptions = {},
): ModelMessage[] {
  const screens = transcriptParts(messages)
    .map(fullScreenText)
    .filter((text) => text !== undefined)
    .map((text) => ({ text, revision: screenRevision(text) }));
  const preserved = new Set<number>();
  for (let at = Math.max(0, screens.length - FULL_SCREEN_PRESERVE_COUNT); at < screens.length; at += 1) {
    preserved.add(at);
  }
  // Follow each preserved screen's fold lines to the screens they depend on,
  // transitively: a preserved screen's fold may name a screen that itself
  // folded another subtree, and only that screen lists it in full.
  const queue = [...preserved];
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const dependency of foldDependencies(screens[index]!.text)) {
      screens.forEach((screen, at) => {
        if (screen.revision === dependency && !preserved.has(at)) {
          preserved.add(at);
          queue.push(at);
        }
      });
    }
  }
  const elidable = screens.filter((_, index) => !preserved.has(index));
  if (elidable.length === 0) return messages;
  const staleBytes = elidable.reduce((bytes, screen) => bytes + Buffer.byteLength(screen.text, 'utf8'), 0);
  if (staleBytes <= (options.keepStaleBytes ?? KEEP_STALE_SCREEN_BYTES)) return messages;
  const preservedRevisions = new Set(
    [...preserved].map((index) => screens[index]!.revision).filter((revision) => revision !== undefined),
  );
  const keep = (text: string): boolean => {
    const revision = screenRevision(text);
    return revision !== undefined && preservedRevisions.has(revision);
  };
  return rewriteOldestParts(messages, elidable.length, {
    user: (part) => (part.type === 'text' && isFullScreen(part.text) && !keep(part.text) ? { ...part, text: elideScreen(part.text) } : undefined),
    tool: (part) => elideResultScreen(part, keep),
  });
}

/** The full-screen text a part carries, if any. */
function fullScreenText(part: UserPart | ToolPart): string | undefined {
  if (part.type === 'text') return isFullScreen(part.text) ? part.text : undefined;
  return part.type === 'tool-result' ? toolResultTexts(part.output).find(isFullScreen) : undefined;
}

/**
 * The tool result with its full screen elided, or undefined when it carries
 * none or the screen is one a surviving screen depends on. A result with a
 * screenshot attached loses only the screen text and keeps its other items:
 * the image, or the notice that replaced it.
 */
function elideResultScreen(part: ToolPart, keep: (text: string) => boolean): ToolPart | undefined {
  if (part.type !== 'tool-result') return undefined;
  const { output } = part;
  if (output.type === 'text') {
    return isFullScreen(output.value) && !keep(output.value) ? { ...part, output: { ...output, value: elideScreen(output.value) } } : undefined;
  }
  if (output.type !== 'content' || !output.value.some(isScreenItem)) return undefined;
  if (output.value.every((item) => !isScreenItem(item) || keep(item.text))) return undefined;
  return {
    ...part,
    output: { ...output, value: output.value.map((item) => (isScreenItem(item) && !keep(item.text) ? { ...item, text: elideScreen(item.text) } : item)) },
  };
}

function isFullScreen(text: string): boolean {
  return FULL_SCREEN_PATTERN.test(text);
}

/** True for the text item of a screenshot-carrying result that holds a full screen. */
function isScreenItem(item: ContentItem): item is Extract<ContentItem, { type: 'text' }> {
  return item.type === 'text' && isFullScreen(item.text);
}

/** Everything before the screen, then the notice in place of the tree. */
function elideScreen(text: string): string {
  const at = text.search(FULL_SCREEN_PATTERN);
  const head = at <= 0 ? (text.split('\n', 1)[0] ?? '') : text.slice(0, at).trimEnd();
  return `${head}\n[earlier screen elided; the newest "Current screen" plus the changes after it describe the screen]`;
}

/** How many of the newest screenshots stay in the transcript verbatim. */
const SCREENSHOT_PRESERVE_COUNT = 2;

/**
 * Superseded screenshots tolerated before they are elided in one batch, so
 * the conversation never carries more than five images. Measured on a
 * 13-turn canvas flow (gpt-5.6, one screenshot per turn, about 670 input
 * tokens each): letting images pile up was cheaper per run — a stale image
 * re-read from the provider's cache costs a tenth of its tokens, while every
 * elision rewrites the request prefix and the rest of the conversation is
 * re-read at full price once — but the model then mis-sequenced the taps in
 * four runs of six, against none of six with this batch. A model that holds
 * a dozen near-identical screenshots loses track of which one is current;
 * the accuracy is worth the cache misses.
 */
const SCREENSHOT_ELIDE_BATCH = 3;

const SCREENSHOT_ELIDED_NOTICE: TextPart = {
  type: 'text',
  text: '[earlier screenshot elided; the newest screenshots show the current screen]',
};

export interface CompactScreenshotHistoryOptions {
  /** Newest screenshots kept verbatim; defaults to two. */
  readonly preserve?: number;
  /** Superseded screenshots tolerated before a batch elision; defaults to three. */
  readonly batch?: number;
}

/**
 * Elides screenshots the transcript no longer needs: every image but the
 * newest few becomes a one-line notice, in the opening prompt and in tool
 * results alike, once enough stale images have piled up. Returns the input
 * array unchanged when nothing qualifies.
 */
export function compactScreenshotHistory(
  messages: ModelMessage[],
  options: CompactScreenshotHistoryOptions = {},
): ModelMessage[] {
  const stale = transcriptParts(messages).filter(carriesImage).length - (options.preserve ?? SCREENSHOT_PRESERVE_COUNT);
  if (stale < (options.batch ?? SCREENSHOT_ELIDE_BATCH)) return messages;
  return rewriteOldestParts(messages, stale, {
    user: (part) => (isImage(part) ? SCREENSHOT_ELIDED_NOTICE : undefined),
    tool: (part) => {
      if (!carriesImage(part) || part.type !== 'tool-result' || part.output.type !== 'content') return undefined;
      return { ...part, output: { type: 'content', value: part.output.value.map((item) => (isImage(item) ? SCREENSHOT_ELIDED_NOTICE : item)) } };
    },
  });
}

/** True for a part that is, or a tool result that contains, an image. */
function carriesImage(part: UserPart | ToolPart): boolean {
  if (part.type === 'tool-result') return part.output.type === 'content' && part.output.value.some(isImage);
  return isImage(part);
}

/** True for a file part whose media type is an image; the shape both the opening prompt and tool results use. */
function isImage(item: { readonly type: string; readonly mediaType?: string }): item is FilePart {
  return item.type === 'file' && (item.mediaType ?? '').startsWith('image/');
}
