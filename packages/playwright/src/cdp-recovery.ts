/** Reattaches to a dedicated remote browser without replacing its persistent context. */

import type { Browser, BrowserContext, Page } from 'playwright';
import { EngineError, raceAbort } from 'e2e/engine';
import { connectCdp } from './browser-connection.ts';
import { cancelled } from './support.ts';

export type CdpEndpointResolver = (signal: AbortSignal) => string | Promise<string>;

interface TargetIdentity {
  readonly targetId: string;
  readonly browserContextId?: string;
}

export interface RecoveredCdpSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page | null;
}

/** A failed reconnect must fail the attempt, never quietly provision another session. */
function failed(detail: string): EngineError {
  return new EngineError('ENGINE_FAILURE', `CDP recovery failed: ${detail}`, { retryable: false });
}

/** Reads protocol identity, independent of URL, document contents, and tab order. */
async function targetIdentity(page: Page): Promise<TargetIdentity> {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Owns a transport to a host-owned browser. Every attempt needs a new browser:
 * Playwright's ordinary incognito contexts are disposed on transport detach,
 * whereas the default context survives and must never be shared by attempts.
 */
export class RecoverableCdpSession {
  private browser: Browser | undefined;
  private attaching: AbortController | undefined;
  private contextId: string | undefined;
  private pageIdentity: TargetIdentity | undefined;
  private readonly usedContexts = new Set<string>();

  constructor(
    private readonly provision: CdpEndpointResolver,
    private readonly reconnect: CdpEndpointResolver,
  ) {}

  /** Provisions one dedicated browser and adopts its default context for this attempt. */
  async start(signal: AbortSignal): Promise<RecoveredCdpSession> {
    return this.attach(this.provision, signal, 60_000, async (browser, context, contextId) => {
      if (this.usedContexts.has(contextId)) {
        throw failed('cdpEndpoint reused a browser from a previous attempt; provision a fresh browser');
      }
      this.usedContexts.add(contextId);
      this.contextId = contextId;
      this.pageIdentity = undefined;
      return { browser, context, page: null };
    });
  }

  /** Remembers the page the attempt actually uses, including its protocol context identity. */
  async rememberPage(page: Page): Promise<void> {
    const browser = this.browser;
    if (browser === undefined) throw failed('no active browser');
    const identity = await targetIdentity(page);
    if (this.browser !== browser) throw cancelled('CDP page identification cancelled');
    this.pageIdentity = identity;
  }

  /** Reconnects once, accepting only the original browser, context, and active target. */
  async recover(signal: AbortSignal, timeoutMs: number): Promise<RecoveredCdpSession> {
    const originalContextId = this.contextId;
    const pageIdentity = this.pageIdentity;
    if (originalContextId === undefined) throw failed('no attempt identity was recorded');
    return this.attach(this.reconnect, signal, timeoutMs, async (browser, context, contextId) => {
      if (contextId !== originalContextId) {
        throw failed('reconnectEndpoint returned a different browser');
      }
      if (pageIdentity === undefined) return { browser, context, page: null };
      for (const page of context.pages()) {
        const identity = await targetIdentity(page);
        if (identity.targetId !== pageIdentity.targetId) continue;
        if (identity.browserContextId !== pageIdentity.browserContextId) {
          throw failed('the original page belongs to a different context');
        }
        return { browser, context, page };
      }
      throw failed('the original page no longer exists');
    });
  }

  /** Detaches the transport; deleting the remote browser remains the host's responsibility. */
  async dispose(): Promise<void> {
    this.attaching?.abort();
    this.attaching = undefined;
    const browser = this.browser;
    this.browser = undefined;
    this.contextId = undefined;
    this.pageIdentity = undefined;
    await browser?.close().catch(() => undefined);
  }

  /** Bounds endpoint resolution, attachment, and identity checks together; late connections detach. */
  private async attach(
    resolve: CdpEndpointResolver,
    parent: AbortSignal,
    timeoutMs: number,
    identify: (browser: Browser, context: BrowserContext, contextId: string) => Promise<RecoveredCdpSession>,
  ): Promise<RecoveredCdpSession> {
    const controller = new AbortController();
    this.attaching?.abort();
    this.attaching = controller;
    const signal = AbortSignal.any([parent, controller.signal]);
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    const work = async (): Promise<RecoveredCdpSession> => {
      if (signal.aborted) throw cancelled('CDP connection cancelled');
      const endpoint = await resolve(signal);
      if (signal.aborted) throw cancelled('CDP connection cancelled');
      if (typeof endpoint !== 'string' || endpoint.trim() === '') throw failed('the endpoint is empty');
      const browser = await connectCdp(endpoint, Math.max(1, timeoutMs));
      const detach = () => { void browser.close().catch(() => undefined); };
      signal.addEventListener('abort', detach, { once: true });
      try {
        if (signal.aborted) throw cancelled('CDP connection cancelled');
        const session = await browser.newBrowserCDPSession();
        let contextId: string | undefined;
        try {
          const contexts = await session.send('Target.getBrowserContexts');
          if (contexts.browserContextIds.length > 0) {
            throw failed('the remote browser must contain only its dedicated default context');
          }
          contextId = contexts.defaultBrowserContextId;
        } finally {
          await session.detach().catch(() => undefined);
        }
        const context = browser.contexts()[0];
        if (context === undefined) throw failed('the default context is missing');
        if (contextId === undefined || contextId === '') throw failed('the default context identity is unavailable');
        if (signal.aborted) throw cancelled('CDP connection cancelled');
        const recovered = await identify(browser, context, contextId);
        if (signal.aborted) throw cancelled('CDP connection cancelled');
        this.browser = browser;
        return recovered;
      } catch (cause) {
        await browser.close().catch(() => undefined);
        throw cause;
      } finally {
        signal.removeEventListener('abort', detach);
      }
    };
    try {
      return await raceAbort(work, signal, 'CDP connection');
    } catch (cause) {
      controller.abort();
      throw cause;
    } finally {
      clearTimeout(timer);
      if (this.attaching === controller) this.attaching = undefined;
    }
  }
}
