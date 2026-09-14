/** Cancellation must release late transports without changing the next attempt's identity. */

import type { Browser, Page } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCdp } from '../../src/browser-connection.ts';
import { RecoverableCdpSession } from '../../src/cdp-recovery.ts';

vi.mock('../../src/browser-connection.ts', () => ({ connectCdp: vi.fn() }));

interface Contexts {
  browserContextIds: string[];
  defaultBrowserContextId?: string;
}

/** A transport whose context identity response can arrive after cancellation. */
function remote(identity?: string, response?: Promise<Contexts>) {
  const pages: Page[] = [];
  const send = vi.fn(async () => response ?? {
    browserContextIds: [],
    ...(identity === undefined ? {} : { defaultBrowserContextId: identity }),
  });
  const close = vi.fn(async () => undefined);
  const browser = {
    newBrowserCDPSession: async () => ({ send, detach: async () => undefined }),
    contexts: () => [{ pages: () => pages }],
    close,
  } as unknown as Browser;
  return { browser, send, close, pages };
}

/** A page target whose identity reply may outlive the attempt that requested it. */
function target(id: string, response?: Promise<{ targetId: string }>) {
  const send = vi.fn(async () => ({ targetInfo: response === undefined ? { targetId: id } : await response }));
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
  } as unknown as Page;
  return { page, send };
}

describe('RecoverableCdpSession cancellation', () => {
  beforeEach(() => vi.mocked(connectCdp).mockReset());

  it('detaches a pending identity check and ignores its response after the next attempt starts', async () => {
    let resolveIdentity!: (contexts: Contexts) => void;
    const old = remote('old', new Promise<Contexts>((resolve) => { resolveIdentity = resolve; }));
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const session = new RecoverableCdpSession(() => 'provisioned', () => 'existing');
    const starting = expect(session.start(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => old.send.mock.calls.length).toBe(1);
    await session.dispose();
    await starting;
    expect(old.close).toHaveBeenCalled();
    await session.start(new AbortController().signal);
    resolveIdentity({ browserContextIds: [], defaultBrowserContextId: 'old' });
    await expect.poll(() => old.close.mock.calls.length).toBeGreaterThan(1);
    expect((await session.recover(new AbortController().signal, 1_000)).browser).toBe(current.browser);
    await session.dispose();
  });

  it('does not attach an endpoint that resolves after dispose', async () => {
    let resolveEndpoint: ((endpoint: string) => void) | undefined;
    const session = new RecoverableCdpSession(
      () => new Promise<string>((resolve) => { resolveEndpoint = resolve; }),
      () => 'existing',
    );
    const starting = expect(session.start(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => resolveEndpoint).toBeTypeOf('function');
    await session.dispose();
    await starting;
    resolveEndpoint!('late');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectCdp).not.toHaveBeenCalled();
  });

  it('ignores an old page identity that arrives after a new attempt remembered its page', async () => {
    const old = remote('old');
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const session = new RecoverableCdpSession(() => 'provisioned', () => 'existing');
    await session.start(new AbortController().signal);
    let resolveIdentity!: (identity: { targetId: string }) => void;
    const delayed = target('old-page', new Promise((resolve) => { resolveIdentity = resolve; }));
    const identifying = expect(session.rememberPage(delayed.page)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => delayed.send.mock.calls.length).toBe(1);
    await session.dispose();
    await session.start(new AbortController().signal);
    const active = target('current-page');
    current.pages.push(active.page);
    await session.rememberPage(active.page);
    resolveIdentity({ targetId: 'old-page' });
    await identifying;
    expect((await session.recover(new AbortController().signal, 1_000)).page).toBe(active.page);
    await session.dispose();
  });

  it('refuses a browser that cannot expose its persistent context identity', async () => {
    const unsupported = remote();
    vi.mocked(connectCdp).mockResolvedValue(unsupported.browser);
    const session = new RecoverableCdpSession(() => 'provisioned', () => 'existing');
    await expect(session.start(new AbortController().signal)).rejects.toThrow(/context identity is unavailable/);
    expect(unsupported.close).toHaveBeenCalled();
    await session.dispose();
  });
});
