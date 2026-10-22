import { createHash } from 'node:crypto';
import { AgentError } from '../agent/error.ts';
import type { ExecutorNode, ExecutorObservation, StepExecutor, StepExecutorContext } from '../agent/executor.ts';
import { TestError } from '../internal/errors.ts';
import type { OcrExecutorOptions, OcrMatch, OcrOptions, OcrQuery, OcrReading, OcrRect, OcrWorkflow } from './types.ts';

const MAX_BOXES = 2_000;
const MAX_TEXT = 2_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** A capture remains private: callers cannot pass old or edited coordinates back to tapText. */
interface Capture {
  readonly observation: ExecutorObservation;
  readonly fingerprint: string;
  readonly startedAt: number;
  readonly reading: OcrReading;
}

type Reader = Pick<StepExecutorContext, 'observe' | 'signal'>;

/** Validates configuration before an executor or tool is registered. */
export function validateOcrOptions(options: OcrOptions): void {
  if (options?.provider === undefined || typeof options.provider.recognize !== 'function' ||
    typeof options.provider.name !== 'string' || options.provider.name.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', 'OCR requires a named provider with recognize()');
  }
  for (const value of [options.timeoutMs, options.maxAgeMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new TestError('INVALID_ARGUMENT', 'OCR time limits must be positive finite milliseconds');
    }
  }
}

/** Runs a model-free, engine-neutral OCR workflow without recording or replaying OCR coordinates. */
export function ocrExecutor(options: OcrExecutorOptions): StepExecutor {
  validateOcrOptions(options);
  return {
    name: options.name ?? 'ocr',
    version: '1',
    cache: 'off',
    runStep: (context) => options.runStep({
      step: context.step, signal: context.signal, target: context.target, attempt: context.attempt,
    }, workflow(context, options)),
  };
}

/** Serializes OCR operations so a later read cannot replace the observation behind an earlier tap. */
function workflow(context: StepExecutorContext, options: OcrOptions): OcrWorkflow {
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(body: () => Promise<T>): Promise<T> => {
    const result = pending.then(body);
    pending = result.catch(() => undefined);
    return result;
  };
  const read = (): Promise<Capture> => capture(context, options);
  return {
    read: () => enqueue(async () => (await read()).reading),
    locate: (query) => enqueue(async () => locate((await read()).reading, query)),
    assertText: (query) => enqueue(async () => {
      const reading = (await read()).reading;
      try {
        return locate(reading, query);
      } catch (error) {
        if (error instanceof AgentError && error.code === 'LOCATOR_NOT_FOUND') {
          throw new AgentError('ASSERTION_FAILED', 'OCR did not find the required text at the requested confidence');
        }
        throw error;
      }
    }),
    tapText: (query) => enqueue(async () => {
      if (context.step.kind !== 'act') {
        throw new AgentError('POLICY_DENIED', 'OCR taps are not permitted in assertion steps');
      }
      if (!context.target.verbs.has('tapAt')) {
        throw new AgentError('AUTOMATION_UNSUPPORTED', 'this target does not support point taps');
      }
      const initial = await read();
      const match = locate(initial.reading, query);
      // An unchanged tree says nothing about a drawn control. Require identical pixels too.
      const latest = await capture(context, options, false);
      if (Date.now() - initial.startedAt > (options.maxAgeMs ?? 2_000) ||
        latest.fingerprint !== initial.fingerprint) {
        throw new AgentError('ACTION_FAILED', 'OCR capture changed or expired; locate the text again before tapping');
      }
      refuseProtectedTarget(latest.observation.tree, match.point);
      context.signal.throwIfAborted();
      return context.actions.tapAt(match.point);
    }),
  };
}

/** Reads OCR evidence through the same pixel policy as every other executor or project tool. */
export async function readOcr(context: Reader, options: OcrOptions): Promise<OcrReading> {
  return (await capture(context, options)).reading;
}

/** Captures full-viewport evidence and bounds even a provider that ignores cancellation. */
async function capture(context: Reader, options: OcrOptions, recognize = true): Promise<Capture> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new AgentError('AUTOMATION_UNSUPPORTED', 'OCR capture or recognition timed out')), options.timeoutMs ?? 10_000);
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const startedAt = Date.now();
  try {
    return await abortable(signal, async () => {
      const observation = await context.observe({ pixels: true, tree: true });
      signal.throwIfAborted();
      const pixels = requirePixels(observation);
      const fingerprint = createHash('sha256').update(pixels.data).update(JSON.stringify({
        width: pixels.width, height: pixels.height, scale: pixels.scale,
        viewport: observation.viewport, path: observation.path,
      })).digest('hex');
      let boxes;
      try {
        boxes = recognize ? await options.provider.recognize({
          data: pixels.data.slice(), mediaType: pixels.mediaType, width: pixels.width, height: pixels.height,
        }, { signal }) : [];
      } catch {
        signal.throwIfAborted();
        throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR provider failed; check the local executable, language data, and provider setup');
      }
      signal.throwIfAborted();
      if (!Array.isArray(boxes) || boxes.length > MAX_BOXES) {
        throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR provider returned too many boxes or an invalid result');
      }
      const matches: OcrMatch[] = [];
      for (const box of boxes) {
        if (box === null || typeof box !== 'object' || typeof box.text !== 'string' ||
          box.text.length > MAX_TEXT || !Number.isFinite(box.confidence) || box.confidence < 0 || box.confidence > 1 ||
          !validRect(box.rect) || !contains({ x: 0, y: 0, width: pixels.width, height: pixels.height }, box.rect)) {
          throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR provider returned invalid text, confidence, or image coordinates');
        }
        if (box.text.trim() === '') continue;
        const rect = { x: box.rect.x / pixels.scale, y: box.rect.y / pixels.scale,
          width: box.rect.width / pixels.scale, height: box.rect.height / pixels.scale };
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        if (point.x >= observation.viewport.width || point.y >= observation.viewport.height) {
          throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR provider returned a point outside the viewport');
        }
        matches.push({ text: box.text, confidence: box.confidence, rect, point });
      }
      return { observation, fingerprint, startedAt, reading: {
        revision: observation.revision, viewport: { ...observation.viewport }, matches,
      } };
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Rejects cropped, rotated, incorrectly scaled, or malformed captures instead of guessing a transform. */
function requirePixels(observation: ExecutorObservation) {
  const pixels = observation.pixels;
  if (pixels === undefined || observation.pixelsWithheld !== undefined) {
    throw new AgentError('POLICY_DENIED', 'OCR requires pixels permitted by the harness; the capture is unavailable or withheld');
  }
  const { width, height, scale, data } = pixels;
  const viewport = observation.viewport;
  const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
  if (pixels.mediaType !== 'image/png' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    !positive(width) || !positive(height) || !positive(scale) || !positive(viewport.width) || !positive(viewport.height) ||
    width * height > 50_000_000 || !(data instanceof Uint8Array) || data.byteLength > MAX_IMAGE_BYTES || data.byteLength < 24 ||
    Math.abs(width - viewport.width * scale) > 1 || Math.abs(height - viewport.height * scale) > 1) {
    throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR requires an uncropped full-viewport PNG with consistent image scale and viewport geometry');
  }
  const header = Buffer.from(data.buffer, data.byteOffset, 24);
  if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.toString('ascii', 12, 16) !== 'IHDR' || header.readUInt32BE(16) !== width || header.readUInt32BE(20) !== height) {
    throw new AgentError('AUTOMATION_UNSUPPORTED', 'OCR PNG dimensions do not match the capture metadata');
  }
  return pixels;
}

/** Finds one sufficiently confident line; ambiguity never selects the first arbitrary box. */
function locate(reading: OcrReading, query: OcrQuery): OcrMatch {
  const confidence = query?.minConfidence ?? 0.8;
  if (typeof query?.text !== 'string' || query.text.trim() === '' || query.text.length > MAX_TEXT ||
    !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
    (query.region !== undefined && !validRect(query.region))) {
    throw new TestError('INVALID_ARGUMENT', 'OCR needs non-empty text, confidence in [0, 1], and a valid region when provided');
  }
  const normalize = (text: string): string => {
    const normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
    return query.caseSensitive === true ? normalized : normalized.toLowerCase();
  };
  const needle = normalize(query.text);
  const matches = reading.matches.filter((match) => {
    const text = normalize(match.text);
    return match.confidence >= confidence && (query.exact === false ? text.includes(needle) : text === needle) &&
      (query.region === undefined || contains(query.region, match.rect));
  });
  if (matches.length === 0) throw new AgentError('LOCATOR_NOT_FOUND', 'OCR found no matching text at the requested confidence');
  if (matches.length !== 1) throw new AgentError('LOCATOR_AMBIGUOUS', 'OCR found multiple matching lines; narrow the text or region');
  return matches[0]!;
}

/** A finite, positive rectangle with a non-negative origin. */
function validRect(rect: OcrRect | undefined): rect is OcrRect {
  return rect !== undefined && rect !== null && typeof rect === 'object' &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0;
}

/** True when the whole candidate lies inside the requested region. */
function contains(region: OcrRect, rect: OcrRect): boolean {
  return rect.x >= region.x && rect.y >= region.y && rect.x + rect.width <= region.x + region.width &&
    rect.y + rect.height <= region.y + region.height;
}

/** Pixel evidence cannot override known disabled or secure semantic controls. */
function refuseProtectedTarget(node: ExecutorNode | undefined, point: { x: number; y: number }): void {
  if (node === undefined || node.states?.hidden === true) return;
  const rect = node.rect;
  if (rect !== undefined && point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height &&
    (node.states?.disabled === true || node.states?.secure === true || node.inputPurpose === 'password')) {
    throw new AgentError('POLICY_DENIED', 'OCR cannot tap a known disabled or secure control');
  }
  for (const child of node.children ?? []) refuseProtectedTarget(child, point);
}

/** Races work against cancellation while observing late failures and always releasing the listener. */
async function abortable<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([body(), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
