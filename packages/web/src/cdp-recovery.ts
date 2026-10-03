/** Validates a persistent CDP binding without publishing or retaining it. */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { EngineError } from 'e2e/engine';
import { connectCdp } from './browser-connection.ts';
import { registerCdpSelectors, requireCdpShadowTracking } from './cdp-selectors.ts';
import { connectionAbort, type ConnectionBudget } from './operation-budget.ts';

export type CdpEndpointResolver = (signal: AbortSignal) => string | Promise<string>;

interface TargetIdentity {
  readonly targetId: string;
  readonly browserContextId?: string;
}

export interface PersistentIdentity {
  readonly contextId: string;
  readonly target?: TargetIdentity;
}

export interface SessionBinding {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page | null;
  readonly identity?: PersistentIdentity;
}

/** A failed reconnect must never quietly provision another session. */
export function recoveryFailed(detail: string): EngineError {
  return new EngineError('ENGINE_FAILURE', `CDP recovery failed: ${detail}`, { retryable: false });
}

/** Reads protocol identity, independent of URL, document contents, and tab order. */
export async function targetIdentity(page: Page): Promise<TargetIdentity> {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Owns an uncommitted connection until its identity is proven; aborted and late connections detach. */
export async function attachPersistent(
  resolve: CdpEndpointResolver,
  budget: ConnectionBudget,
  previous?: PersistentIdentity,
): Promise<SessionBinding & { readonly identity: PersistentIdentity }> {
  const { signal } = budget;
  const deadline = Date.now() + budget.timeoutMs;
  const check = () => { if (signal.aborted) throw connectionAbort(signal, 'CDP connection'); };
  check();
  const endpoint = await resolve(signal);
  check();
  if (typeof endpoint !== 'string' || endpoint.trim() === '') throw recoveryFailed('the endpoint is empty');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new EngineError('OPERATION_TIMEOUT', 'CDP connection timed out', { retryable: false });
  const browser = await connectCdp(endpoint, remaining);
  const detach = () => { void browser.close().catch(() => undefined); };
  signal.addEventListener('abort', detach, { once: true });
  try {
    check();
    const session = await browser.newBrowserCDPSession();
    let contextId: string | undefined;
    try {
      const contexts = await session.send('Target.getBrowserContexts');
      if (contexts.browserContextIds.length > 0) {
        throw recoveryFailed('the remote browser must contain only its dedicated default context');
      }
      contextId = contexts.defaultBrowserContextId;
    } finally {
      await session.detach().catch(() => undefined);
    }
    check();
    const context = browser.contexts()[0];
    if (context === undefined) throw recoveryFailed('the default context is missing');
    if (contextId === undefined || contextId === '') throw recoveryFailed('the default context identity is unavailable');
    if (previous !== undefined && contextId !== previous.contextId) {
      throw recoveryFailed('reconnectEndpoint returned a different browser');
    }
    await registerCdpSelectors(context, { signal, timeoutMs: deadline - Date.now() });
    check();
    if (previous?.target === undefined) return { browser, context, page: null, identity: { contextId } };
    for (const page of context.pages()) {
      const target = await targetIdentity(page);
      check();
      if (target.targetId !== previous.target.targetId) continue;
      if (target.browserContextId !== previous.target.browserContextId) {
        throw recoveryFailed('the original page belongs to a different context');
      }
      await requireCdpShadowTracking(page, { signal, timeoutMs: deadline - Date.now() });
      return { browser, context, page, identity: { contextId, target } };
    }
    throw recoveryFailed('the original page no longer exists');
  } catch (cause) {
    await browser.close().catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener('abort', detach);
  }
}
