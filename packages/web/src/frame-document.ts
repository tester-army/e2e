/** Which frames hold a document script can read. */

import type { ElementHandle, Frame } from 'playwright-core';

/**
 * True when Playwright can evaluate in the frame without waiting on a
 * navigation.
 *
 * A child frame that has not committed a navigation (its URL is empty, as
 * while its first request is held) shows its initial empty document.
 * Chromium creates no script context for that document until script in its
 * parent touches it, and Playwright waits for the navigation to commit
 * instead. Reading `contentDocument` from the parent is that touch, so the
 * frame is readable from then on. A parent that cannot read it (a sandboxed
 * frame) means no script could have written into it either: it shows
 * nothing. When the check itself fails, the frame counts as readable, so the
 * caller's own read of it decides. `owner` is the frame's element when the
 * caller already holds it.
 */
export async function hasReadableDocument(frame: Frame, owner?: ElementHandle): Promise<boolean> {
  if (frame.url() !== '' || frame.parentFrame() === null) return true;
  if (owner !== undefined) return parentReadsDocument(owner);
  const fetched = await frame.frameElement().catch(() => null);
  if (fetched === null) return true;
  try {
    return await parentReadsDocument(fetched);
  } finally {
    await fetched.dispose().catch(() => undefined);
  }
}

/** The page's frames whose documents script can read; see `hasReadableDocument`. */
export async function readableFrames(frames: readonly Frame[]): Promise<Frame[]> {
  const readable = await Promise.all(frames.map((frame) => hasReadableDocument(frame)));
  return frames.filter((_, index) => readable[index]);
}

/** Reads the frame's document from its parent, which gives it a script context; true when that read fails. */
function parentReadsDocument(owner: ElementHandle): Promise<boolean> {
  return owner.evaluate((element) => 'contentDocument' in element && element.contentDocument !== null).catch(() => true);
}
