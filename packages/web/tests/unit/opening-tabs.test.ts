/**
 * The wait for tabs being opened, against a fake CDP session: the parts a
 * real browser cannot be made to stall on.
 */
import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { OpeningTabs } from '../../src/opening-tabs.ts';

type Listener = (event: never) => void;

/** A browser whose CDP session reports what the test emits, and a page whose own CDP session never answers. */
function stalledBrowser(): { browser: Browser; context: BrowserContext; page: Page; emit: (event: string, payload: unknown) => void } {
  const listeners = new Map<string, Listener[]>();
  const cdp = {
    on: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    send: async () => ({}),
    detach: async () => undefined,
  };
  const browser = { newBrowserCDPSession: async () => cdp } as unknown as Browser;
  const context = { on: () => undefined, off: () => undefined } as unknown as BrowserContext;
  const page = { context: () => ({ newCDPSession: () => new Promise(() => undefined) }) } as unknown as Page;
  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) (listener as (payload: unknown) => void)(payload);
  };
  return { browser, context, page, emit };
}

describe('OpeningTabs', () => {
  it('gives up at the deadline while the attempt context cannot be identified', async () => {
    const { browser, context, page, emit } = stalledBrowser();
    const opening = await OpeningTabs.watch(browser, context, undefined);
    emit('Target.targetCreated', { targetInfo: { targetId: 'popup', type: 'page', openerId: 'opener', browserContextId: 'ctx' } });
    const started = Date.now();
    const settled = await opening!.settled(page, new AbortController().signal, started + 50);
    expect(settled).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('settles at once when the context is known and the tab is in another one', async () => {
    const { browser, context, page, emit } = stalledBrowser();
    const opening = await OpeningTabs.watch(browser, context, 'mine');
    emit('Target.targetCreated', { targetInfo: { targetId: 'popup', type: 'page', openerId: 'opener', browserContextId: 'other' } });
    expect(await opening!.settled(page, new AbortController().signal, Date.now() + 1_000)).toBe(true);
  });
});
