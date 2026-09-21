/** Registers the closed-root masking selector in a CDP default context. */

import type { BrowserContext, Page } from 'playwright';
import { EngineError } from 'e2e/engine';
import { connectionAbort, type ConnectionBudget } from './operation-budget.ts';
import { CLOSED_SHADOW_ROOTS_KEY, CLOSED_SHADOW_SELECTOR_ENGINE, CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE } from './read-node.ts';

interface SelectorChannel {
  registerSelectorEngine(
    params: { readonly selectorEngine: { readonly name: string; readonly source: string; readonly contentScript: boolean } },
    options: { readonly timeout: number; readonly signal: AbortSignal },
  ): Promise<unknown>;
}

/**
 * Playwright 1.63 seeds custom selectors only in newly created contexts, not
 * the persistent context returned by connectOverCDP. Its public register API
 * rejects an already registered name before reaching that context. Use the
 * same context channel as selectors.register, without allocating global names
 * on every reconnect. Missing channel support must prevent masked capture.
 */
export async function registerCdpSelectors(context: BrowserContext, budget: ConnectionBudget): Promise<void> {
  if (budget.signal.aborted) throw connectionAbort(budget.signal, 'CDP selector registration');
  if (budget.timeoutMs <= 0) {
    throw new EngineError('OPERATION_TIMEOUT', 'CDP selector registration timed out', { retryable: false });
  }
  const channel: unknown = Reflect.get(context, '_channel');
  const register = channel !== null && typeof channel === 'object' ? Reflect.get(channel, 'registerSelectorEngine') : undefined;
  if (typeof register !== 'function') {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'this Playwright version cannot install secure-field masks in the CDP context', { retryable: false });
  }
  try {
    await (channel as SelectorChannel).registerSelectorEngine({ selectorEngine: {
      name: CLOSED_SHADOW_SELECTOR_ENGINE,
      source: `(${CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE})(undefined)`,
      contentScript: false,
    } }, { timeout: budget.timeoutMs, signal: budget.signal });
  } catch (cause) {
    // A version that seeds CDP contexts already has our process-wide registration.
    const duplicate = `"${CLOSED_SHADOW_SELECTOR_ENGINE}" selector engine has been already registered`;
    if (!(cause instanceof Error) || !cause.message.endsWith(duplicate)) throw cause;
  }
}

/** Existing closed roots cannot be recovered if their document loaded without the tracking hook. */
export async function requireCdpShadowTracking(page: Page, budget: ConnectionBudget): Promise<void> {
  if (budget.signal.aborted) throw connectionAbort(budget.signal, 'CDP tracking verification');
  const tracked = await Promise.all(page.frames().map((frame) =>
    frame.evaluate((key) => Reflect.get(globalThis, Symbol.for(key)) instanceof WeakMap, CLOSED_SHADOW_ROOTS_KEY),
  ));
  if (budget.signal.aborted) throw connectionAbort(budget.signal, 'CDP tracking verification');
  if (tracked.some((present) => !present)) {
    throw new EngineError('ENGINE_FAILURE', 'CDP recovery failed: secure-field tracking is unavailable after a document changed while disconnected', { retryable: false });
  }
}
