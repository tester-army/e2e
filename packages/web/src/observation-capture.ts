/** One observation transaction: settling, semantic capture, masked pixels, and staged refs. */

import type { Page } from 'playwright';
import { EngineError, type EngineObserveOptions, type EngineSnapshot, type OperationContext } from 'e2e/engine';
import { CaptureScope } from './capture-scope.ts';
import { captureDocument, ROOT_NODE_ID } from './observation.ts';
import { capturePixels } from './observe.ts';
import { RefRegistry, type CapturedObservation } from './refs.ts';
import { cancelled, DEFAULT_VIEWPORT, type ActionTarget } from './support.ts';

/** Shared node budget across the main document and its frames. */
const MAX_OBSERVED_NODES = 3_000;
/** Settling is best-effort and spends from the observation's total budget. */
const SETTLE_TIMEOUT_MS = 5_000;
/** Leave time for a fresh masked screenshot after semantic capture expires. */
const PIXEL_FALLBACK_RESERVE_MS = 2_000;

interface CaptureSettings {
  readonly testIdAttribute: string;
  readonly site: string | undefined;
}

/** Captures under one deadline, retaining no refs from a failed or abandoned document. */
export async function captureObservation(
  page: Page,
  refs: RefRegistry,
  settings: CaptureSettings,
  operation: OperationContext,
  options: EngineObserveOptions | undefined,
): Promise<CapturedObservation> {
  const deadline = Date.now() + operation.timeoutMs;
  let accepting = true;
  const generation = new Map<string, ActionTarget>();
  try {
    const settleDeadline = Math.min(deadline, Date.now() + SETTLE_TIMEOUT_MS);
    await new CaptureScope(settleDeadline, operation.signal).run(() => page.waitForLoadState('domcontentloaded', {
      timeout: Math.max(1, settleDeadline - Date.now()),
    })).catch(() => undefined);
    if (operation.signal.aborted) throw cancelled('observe cancelled');
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const semanticDeadline = options?.pixelFallback === true
      ? deadline - Math.min(PIXEL_FALLBACK_RESERVE_MS, (deadline - Date.now()) / 4)
      : deadline;
    // The initial image is independent of the reader. A fallback always takes a fresh one.
    const pixelCapture = options?.pixels === true
      ? capturePixels(page, { ...operation, timeoutMs: semanticDeadline - Date.now() }, viewport).catch(() => undefined)
      : Promise.resolve(undefined);
    let snapshot: EngineSnapshot;
    try {
      const [captured, pixels] = await Promise.all([
        captureDocument({
          ...settings,
          reserveIds: (count) => refs.reserveIds(count),
          commit: (id, element) => {
            if (accepting && !operation.signal.aborted) generation.set(id, { kind: 'element', element });
            else void element.dispose().catch(() => undefined);
          },
        }, page, {
          framePath: [], budget: MAX_OBSERVED_NODES,
          deadline: semanticDeadline, signal: operation.signal,
        }),
        pixelCapture,
      ]);
      snapshot = {
        location: page.url(),
        root: captured.tree,
        viewport: { width: viewport.width, height: viewport.height },
        ...(captured.truncated ? { truncated: true } : {}),
        ...(pixels === undefined ? {} : { pixels: pixels.pixels, maskedRegionCount: pixels.maskedRegionCount }),
      };
    } catch (cause) {
      RefRegistry.dispose(generation);
      generation.clear();
      if (options?.pixelFallback !== true || !(cause instanceof EngineError) || cause.code !== 'OPERATION_TIMEOUT') throw cause;
      await pixelCapture;
      const fallbackViewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
      const pixels = await capturePixels(page, {
        ...operation, timeoutMs: deadline - Date.now(),
      }, fallbackViewport);
      if (!pixels.maskingProven) throw cause;
      snapshot = {
        location: page.url(),
        root: { ref: { id: ROOT_NODE_ID, revision: '' } },
        viewport: { width: fallbackViewport.width, height: fallbackViewport.height },
        truncated: true,
        treeUnavailable: true,
        pixels: pixels.pixels,
        maskedRegionCount: pixels.maskedRegionCount,
      };
    }
    return { snapshot, generation };
  } catch (cause) {
    RefRegistry.dispose(generation);
    generation.clear();
    throw cause;
  } finally {
    accepting = false;
  }
}
