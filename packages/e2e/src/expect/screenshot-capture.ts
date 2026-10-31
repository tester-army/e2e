/**
 * One `toHaveScreenshot` capture: the engine's observation pixels at one
 * image pixel per viewport pixel, so a screenshot is the same size on every
 * device density, cut to the subject's box when there is one, the masks
 * painted over.
 */

import type { LocatorExpression } from '../engine/surface.ts';
import { ConfigurationError, isE2EError } from '../internal/errors.ts';
import { clipBox, cropImage, decodePng, fillBoxes, resampleImage, type ImageBox, type RgbaImage } from '../internal/image.ts';
import type { ReadWindow } from '../internal/time.ts';
import { isNodeVisible } from '../locator/engine.ts';
import { describeExpression } from '../locator/expression.ts';
import type { ScreenContext } from '../locator/screen.ts';
import { pixelsProvenMasked } from '../run/secrecy.ts';

/** What one call captures. */
export interface CaptureRequest {
  readonly api: string;
  /** The locator whose box is kept; undefined keeps the whole screen. */
  readonly subject: LocatorExpression | undefined;
  readonly masks: readonly LocatorExpression[];
  readonly maskColor: readonly [number, number, number];
}

/** One capture, or why there is none yet. */
export type Capture = { readonly image: RgbaImage } | { readonly missing: string };

/**
 * Captures for one call. The subject is scrolled into view once, the first
 * time it is found; a subject that is not there yet is a capture still
 * missing, so the call's poll keeps waiting and fails as an assertion. A
 * capture the deadline cut short throws, and the poll judges it as it judges
 * any read it cut off.
 */
export function screenshotCapturer(context: ScreenContext, request: CaptureRequest, reads: ReadWindow): () => Promise<Capture> {
  const state = { scrolled: !context.engine.session.actions.has('scrollIntoView') };
  return () => captureOnce(context, request, reads, state);
}

/** One capture; `state.scrolled` records that the subject was scrolled into view. */
async function captureOnce(context: ScreenContext, request: CaptureRequest, reads: ReadWindow, state: { scrolled: boolean }): Promise<Capture> {
  const { engine } = context;
  const shown = request.subject === undefined ? 'screen' : describeExpression(request.subject);
  let box: ImageBox | undefined;
  if (request.subject !== undefined) {
    let { node } = await engine.tryRead(request.subject, reads);
    if (node !== null && !state.scrolled) {
      try {
        await engine.performUntil(request.subject, { kind: 'scrollIntoView' }, reads.deadline);
      } catch (cause) {
        if (!isE2EError(cause) || cause.code !== 'LOCATOR_NOT_FOUND') throw cause;
      }
      state.scrolled = true;
      ({ node } = await engine.tryRead(request.subject, reads));
    }
    if (node === null) return { missing: `no node matches ${shown}` };
    if (!isNodeVisible(node) || node.rect === undefined) return { missing: `${shown} is not visible` };
    box = node.rect;
  }
  const observation = await reads.read((timeoutMs) => engine.session.observe(engine.readOperation(timeoutMs), { pixels: true, comparable: true }));
  if (observation.pixels === undefined) return { missing: 'the engine returned no screenshot' };
  if (!pixelsProvenMasked(observation.redaction)) {
    throw new ConfigurationError('POLICY_DENIED', `${request.api} could not prove every secure field on screen was masked, so the screenshot is not kept`);
  }
  const { pixels } = observation;
  const scale = pixels.scale > 0 ? pixels.scale : 1;
  const raw = decodePng(pixels.data);
  let image = resampleImage(raw, Math.max(1, Math.round(raw.width / scale)), Math.max(1, Math.round(raw.height / scale)));
  let origin = { x: 0, y: 0 };
  if (box !== undefined) {
    const clipped = clipBox(image, box);
    if (clipped === undefined) return { missing: `${shown} is outside the viewport` };
    image = cropImage(image, clipped);
    origin = clipped;
  }
  if (request.masks.length === 0) return { image };
  const boxes: ImageBox[] = [];
  for (const mask of request.masks) {
    for (const node of await engine.readAllNow(mask, reads)) {
      if (isNodeVisible(node) && node.rect !== undefined) boxes.push({ ...node.rect, x: node.rect.x - origin.x, y: node.rect.y - origin.y });
    }
  }
  return { image: fillBoxes(image, boxes, request.maskColor) };
}
