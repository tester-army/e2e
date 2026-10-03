/** Registers the engine's selector engines in a CDP default context; every locator and secure-field mask needs them. */

import type { BrowserContext, Page } from 'playwright-core';
import { EngineError } from 'e2e/engine';
import { connectionAbort, type ConnectionBudget } from './operation-budget.ts';
import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import { SELECTOR_ENGINES } from './selector-engines.ts';

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
 * on every reconnect. Missing channel support must fail the connection: every
 * locator resolves through these engines and every masked capture relies on them.
 */
export async function registerCdpSelectors(context: BrowserContext, budget: ConnectionBudget): Promise<void> {
  if (budget.signal.aborted) throw connectionAbort(budget.signal, 'CDP selector registration');
  if (budget.timeoutMs <= 0) {
    throw new EngineError('OPERATION_TIMEOUT', 'CDP selector registration timed out', { retryable: false });
  }
  const channel: unknown = Reflect.get(context, '_channel');
  const register = channel !== null && typeof channel === 'object' ? Reflect.get(channel, 'registerSelectorEngine') : undefined;
  if (typeof register !== 'function') {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'this Playwright version cannot register selector engines in the CDP context; locators and secure-field masks need them', { retryable: false });
  }
  for (const { name, source } of SELECTOR_ENGINES) {
    try {
      await (channel as SelectorChannel).registerSelectorEngine({ selectorEngine: {
        name,
        source: `(${source})(undefined)`,
        contentScript: false,
      } }, { timeout: budget.timeoutMs, signal: budget.signal });
    } catch (cause) {
      // A version that seeds CDP contexts already has our process-wide registration.
      const duplicate = `"${name}" selector engine has been already registered`;
      if (!(cause instanceof Error) || !cause.message.endsWith(duplicate)) throw cause;
    }
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
    throw new EngineError('ENGINE_FAILURE', 'CDP recovery failed: closed shadow root tracking is unavailable after a document changed while disconnected; locators and secure-field masks need it', { retryable: false });
  }
}
