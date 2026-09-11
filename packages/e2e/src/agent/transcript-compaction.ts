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

import type { FilePart, ModelMessage, TextPart, UserContent } from 'ai';
import { FULL_SCREEN_PATTERN } from './screen-update.ts';

/** A part of a user message; a string message counts as one text part. */
type UserPart = Exclude<UserContent, string>[number];
/** A part of a tool message. */
type ToolPart = Extract<ModelMessage, { role: 'tool' }>['content'][number];

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
 */
const FULL_SCREEN_PRESERVE_COUNT = 1;

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
 * the newest few is reduced to its lead and a notice, in the opening prompt
 * and in tool results alike, once the stale screens together outgrow the
 * budget. Diffs are never touched. Returns the input array unchanged when
 * nothing qualifies, so the caller can skip the override.
 */
export function compactScreenHistory(
  messages: ModelMessage[],
  options: CompactScreenHistoryOptions = {},
): ModelMessage[] {
  const screens = transcriptParts(messages).map(fullScreenText).filter((text) => text !== undefined);
  const stale = screens.length - FULL_SCREEN_PRESERVE_COUNT;
  if (stale <= 0) return messages;
  const staleBytes = screens.slice(0, stale).reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
  if (staleBytes <= (options.keepStaleBytes ?? KEEP_STALE_SCREEN_BYTES)) return messages;
  return rewriteOldestParts(messages, stale, {
    user: (part) => (part.type === 'text' && FULL_SCREEN_PATTERN.test(part.text) ? { ...part, text: elideScreen(part.text) } : undefined),
    tool: (part) => {
      const text = fullScreenText(part);
      return text === undefined ? undefined : { ...part, output: { type: 'text', value: elideScreen(text) } };
    },
  });
}

/** The full-screen text a part carries, if any. */
function fullScreenText(part: UserPart | ToolPart): string | undefined {
  if (part.type === 'text') return FULL_SCREEN_PATTERN.test(part.text) ? part.text : undefined;
  if (part.type !== 'tool-result' || part.output.type !== 'text' || typeof part.output.value !== 'string') return undefined;
  return FULL_SCREEN_PATTERN.test(part.output.value) ? part.output.value : undefined;
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
