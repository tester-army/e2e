/** Validates a persistent CDP binding without publishing or retaining it. */
import type { Browser, BrowserContext, Page } from 'playwright';
import { EngineError } from 'e2e/engine';
import { connectCdp } from './browser-connection.ts';
import { registerCdpSelectors, requireCdpShadowTracking } from './cdp-selectors.ts';
import { connectionAbort, type ConnectionBudget } from './operation-budget.ts';

export type CdpEndpointResolver = (signal: AbortSignal) => string | Promise<string>;

/** A page's protocol identity, independent of URL, document contents, and tab order. */
export interface TargetIdentity {
  readonly targetId: string;
  readonly browserContextId?: string;
}

/**
 * One page the attempt entered: the page object of the current transport and,
 * where the transport can be recovered, the protocol target that names the
 * same page on the next one.
 */
export interface StackedPage {
  readonly page: Page;
  readonly target?: TargetIdentity;
}

/**
 * A connection as the session publishes it: the transport, its one context,
 * and the pages entered on it in order, the active one on top. `contextId`
 * is the persistent default context's protocol id and is what a recovery
 * checks; an ordinary launched context has none.
 */
export interface Connection {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly contextId?: string;
  readonly stack: readonly StackedPage[];
}

/** True when both name the same page: by target where the transport can change, by page object otherwise. */
export function samePage(a: StackedPage, b: StackedPage): boolean {
  return a.target !== undefined && b.target !== undefined ? a.target.targetId === b.target.targetId : a.page === b.page;
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

/**
 * Owns an uncommitted connection until its identity is proven; aborted and
 * late connections detach. With `previous`, the reconnect must reach the same
 * persistent context, and the stack is found again page by page from its
 * targets: a page that closed while disconnected is dropped from it, and a
 * stack with nothing left fails, since a URL match is never enough to pick a
 * replacement tab.
 */
export async function attachPersistent(
  resolve: CdpEndpointResolver,
  budget: ConnectionBudget,
  previous?: { readonly contextId: string; readonly stack: readonly StackedPage[] },
): Promise<Connection & { readonly contextId: string }> {
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
    if (previous === undefined || previous.stack.length === 0) return { browser, context, contextId, stack: [] };
    const stack = await resolveStack(context, previous.stack, { signal, timeoutMs: deadline - Date.now() });
    return { browser, context, contextId, stack };
  } catch (cause) {
    await browser.close().catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener('abort', detach);
  }
}

/**
 * Finds each page of `previous` again among `context.pages()` by its target
 * id, in stack order. A page whose target is gone closed while disconnected
 * and leaves the stack, as its close would have taken it off; a stack with
 * nothing left has no page to recover. Every recovered page must still carry
 * the closed-root tracking hook its locators and masks rely on.
 */
async function resolveStack(
  context: BrowserContext,
  previous: readonly StackedPage[],
  budget: ConnectionBudget,
): Promise<readonly StackedPage[]> {
  const { signal } = budget;
  const check = () => { if (signal.aborted) throw connectionAbort(signal, 'CDP connection'); };
  const present = new Map<string, StackedPage>();
  for (const page of context.pages()) {
    const target = await targetIdentity(page);
    check();
    present.set(target.targetId, { page, target });
  }
  const stack: StackedPage[] = [];
  for (const entry of previous) {
    if (entry.target === undefined) throw recoveryFailed('a page of the attempt has no target identity');
    const found = present.get(entry.target.targetId);
    if (found === undefined) continue;
    if (found.target?.browserContextId !== entry.target.browserContextId) {
      throw recoveryFailed('the original page belongs to a different context');
    }
    await requireCdpShadowTracking(found.page, budget);
    check();
    stack.push(found);
  }
  if (stack.length === 0) throw recoveryFailed('the original page no longer exists');
  return stack;
}
