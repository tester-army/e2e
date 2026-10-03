/** An attempt owns pending connections and rejects work from retired generations. */
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCdp } from '../../src/browser-connection.ts';
import { AttemptSession } from '../../src/attempt-session.ts';

vi.mock('../../src/browser-connection.ts', () => ({ connectCdp: vi.fn() }));

/** A deferred protocol response or endpoint. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Contexts { browserContextIds: string[]; defaultBrowserContextId?: string }

/** A transport whose identity may arrive after cancellation. */
function remote(identity?: string, response?: Promise<Contexts>) {
  let connected = true;
  const pages: Page[] = [];
  const send = vi.fn(async () => response ?? { browserContextIds: [], ...(identity === undefined ? {} : { defaultBrowserContextId: identity }) });
  const close = vi.fn(async () => { connected = false; });
  const browser = {
    newBrowserCDPSession: async () => ({ send, detach: async () => undefined }),
    contexts: () => [{ pages: () => pages, newPage: async () => pages.at(-1)!, _channel: { registerSelectorEngine: async () => undefined } }],
    isConnected: () => connected,
    close,
  } as unknown as Browser;
  return { browser, send, close, pages, disconnect: () => { connected = false; } };
}

/** A page target whose identity response may outlive its attempt. */
function target(id: string, response?: Promise<{ targetId: string }>) {
  const send = vi.fn(async () => ({ targetInfo: response === undefined ? { targetId: id } : await response }));
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
    setViewportSize: async () => undefined,
    viewportSize: () => ({ width: 320, height: 200 }),
    isClosed: () => false,
    goto: async () => null,
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  return { page, send };
}

/** Creates a separate owner while the worker remembers already-used remote contexts. */
function session(options: {
  provision?: (signal: AbortSignal) => string | Promise<string>;
  reconnect?: (signal: AbortSignal) => string | Promise<string>;
  used?: Set<string>;
  configure?: () => Promise<void>;
  artifactsDir?: string;
  viewport?: { width: number; height: number } | null;
} = {}) {
  return new AttemptSession({
    artifactsDir: options.artifactsDir ?? tmpdir(), viewport: options.viewport === undefined ? { width: 320, height: 200 } : options.viewport, contextOptions: {}, screencast: {},
    acquire: async () => { throw new Error('persistent attempts never acquire the shared browser'); },
    configure: options.configure ?? (async () => undefined),
    persistent: { provision: options.provision ?? (() => 'provisioned'), reconnect: options.reconnect ?? (() => 'existing'), usedContexts: options.used ?? new Set() },
  });
}

const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const operation = (timeoutMs = 1_000, signal = new AbortController().signal) => ({ timeoutMs, signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });

describe('AttemptSession', () => {
  beforeEach(() => vi.mocked(connectCdp).mockReset());
  afterEach(() => vi.useRealTimers());

  it('detaches an unresolved identity before its response arrives and cannot overwrite the next attempt', async () => {
    const response = deferred<Contexts>();
    const old = remote('old', response.promise);
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session();
    const starting = expect(first.start(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => old.send.mock.calls.length).toBe(1);
    await first.close(cleanup());
    await starting;
    expect(old.close).toHaveBeenCalled();
    const next = session();
    await next.start(new AbortController().signal);
    response.resolve({ browserContextIds: [], defaultBrowserContextId: 'old' });
    await expect.poll(() => old.close.mock.calls.length).toBeGreaterThan(1);
    expect(next.current().browser).toBe(current.browser);
    await next.close(cleanup());
  });

  it('leaves the persistent page at the window size under viewport: null', async () => {
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const setViewportSize = vi.fn(async () => undefined);
    const active = target('page');
    (active.page as unknown as { setViewportSize: unknown }).setViewportSize = setViewportSize;
    current.pages.push(active.page);
    const owner = session({ viewport: null });
    await owner.start(new AbortController().signal);
    await owner.ensurePage();
    expect(setViewportSize).not.toHaveBeenCalled();
    await owner.close(cleanup());
  });

  it('serves the first page from the persistent browser\'s own tab, on a fresh document, and opens a new tab after it closed', async () => {
    const current = remote('current');
    const initial = target('initial');
    const goto = vi.fn(async () => null);
    let closed = false;
    Object.assign(initial.page, { goto, isClosed: () => closed });
    const opened = target('opened');
    current.pages.push(initial.page);
    const newPage = vi.fn(async () => opened.page);
    const context = { ...current.browser.contexts()[0]!, newPage };
    Object.assign(current.browser, { contexts: () => [context] });
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const owner = session();
    await owner.start(new AbortController().signal);
    expect(await owner.ensurePage()).toBe(initial.page);
    expect(goto).toHaveBeenCalledWith('about:blank');
    expect(newPage).not.toHaveBeenCalled();
    closed = true;
    expect(await owner.ensurePage()).toBe(opened.page);
    expect(newPage).toHaveBeenCalledTimes(1);
    await owner.close(cleanup());
  });

  it('opens a new tab in an ordinary context, whatever pages the browser already shows', async () => {
    const existing = target('existing').page;
    const opened = target('opened').page;
    const newPage = vi.fn(async () => opened);
    const context = { pages: () => [existing], newPage, close: async () => undefined };
    const owner = new AttemptSession({
      artifactsDir: tmpdir(), viewport: { width: 320, height: 200 }, contextOptions: {}, screencast: {},
      acquire: async () => ({ newContext: async () => context }) as unknown as Browser,
      configure: async () => undefined,
    });
    await owner.start(new AbortController().signal);
    expect(await owner.ensurePage()).toBe(opened);
    expect(newPage).toHaveBeenCalledTimes(1);
    await owner.close(cleanup());
  });

  it('refuses a viewport that is not whole pixels, keeps a copy of the one it accepts, and resizes an open page', async () => {
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValue(current.browser);
    const setViewportSize = vi.fn(async (_size: { width: number; height: number }) => undefined);
    const active = target('page');
    (active.page as unknown as { setViewportSize: unknown }).setViewportSize = setViewportSize;
    current.pages.push(active.page);
    const owner = session({ viewport: null });
    await owner.start(new AbortController().signal);
    await expect(owner.setViewport({ width: 390.5, height: 600 })).rejects.toThrow('whole, non-negative pixels, got 390.5x600');
    await expect(owner.setViewport({ width: 390, height: -1 })).rejects.toThrow('got 390x-1');
    expect(setViewportSize).not.toHaveBeenCalled();
    const size = { width: 390, height: 600 };
    await owner.setViewport(size);
    size.width = 1000;
    await owner.ensurePage();
    expect(setViewportSize).toHaveBeenCalled();
    for (const [called] of setViewportSize.mock.calls) expect(called).toEqual({ width: 390, height: 600 });
    await owner.setViewport({ width: 800, height: 600 });
    expect(setViewportSize).toHaveBeenLastCalledWith({ width: 800, height: 600 });
    await owner.close(cleanup());
  });

  it('does not attach an endpoint that resolves after disposal', async () => {
    const endpoint = deferred<string>();
    const provision = vi.fn(() => endpoint.promise);
    const first = session({ provision });
    const starting = expect(first.start(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => provision.mock.calls.length).toBe(1);
    await first.close(cleanup());
    await starting;
    endpoint.resolve('late');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectCdp).not.toHaveBeenCalled();
  });

  it('keeps a late old-page identity out of the next attempt', async () => {
    const old = remote('old');
    const current = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session();
    await first.start(new AbortController().signal);
    const response = deferred<{ targetId: string }>();
    const delayed = target('old-page', response.promise);
    old.pages.push(delayed.page);
    const opening = expect(first.ensurePage()).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect.poll(() => delayed.send.mock.calls.length).toBe(1);
    await first.close(cleanup());
    const next = session();
    await next.start(new AbortController().signal);
    const active = target('current-page');
    current.pages.push(active.page);
    await next.ensurePage();
    response.resolve({ targetId: 'old-page' });
    await opening;
    expect(next.current().page).toBe(active.page);
    await next.close(cleanup());
  });

  it('does not publish an attachment until configuration succeeds', async () => {
    const configure = deferred<void>();
    const browser = remote('current');
    vi.mocked(connectCdp).mockResolvedValue(browser.browser);
    const first = session({ configure: () => configure.promise });
    const starting = first.start(new AbortController().signal);
    await expect.poll(() => browser.send.mock.calls.length).toBe(1);
    expect(() => first.current()).toThrow(/no attempt connection is ready/);
    configure.resolve();
    await starting;
    expect(first.current().browser).toBe(browser.browser);
    await first.close(cleanup());
  });

  it.each(['timeout', 'cancel'] as const)('distinguishes recovery %s and prevents dispatch', async (reason) => {
    const browser = remote('current');
    vi.mocked(connectCdp).mockResolvedValue(browser.browser);
    let resolverSignal: AbortSignal | undefined;
    const requested = deferred<void>();
    const first = session({ reconnect: (signal) => {
      resolverSignal = signal;
      requested.resolve();
      return new Promise<string>(() => undefined);
    } });
    await first.start(new AbortController().signal);
    browser.disconnect();
    const caller = new AbortController();
    const dispatch = vi.fn(async () => undefined);
    const code = reason === 'timeout' ? 'OPERATION_TIMEOUT' : 'CANCELLED';
    const result = expect(first.run(operation(reason === 'timeout' ? 30 : 1_000, caller.signal), 'read', dispatch)).rejects.toMatchObject({ code });
    await requested.promise;
    if (reason === 'cancel') caller.abort();
    await result;
    expect(caller.signal.aborted).toBe(reason === 'cancel');
    expect(resolverSignal?.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(first.run(operation(), 'read', dispatch)).rejects.toMatchObject({ code });
    await first.close(cleanup());
  });

  it('refuses a remote that cannot expose its persistent context identity', async () => {
    const unsupported = remote();
    vi.mocked(connectCdp).mockResolvedValue(unsupported.browser);
    const first = session();
    await expect(first.start(new AbortController().signal)).rejects.toThrow(/context identity is unavailable/);
    expect(unsupported.close).toHaveBeenCalled();
    await first.close(cleanup());
  });

  it('propagates the recovery owner cancellation to another waiting operation', async () => {
    const browser = remote('current');
    vi.mocked(connectCdp).mockResolvedValue(browser.browser);
    const requested = deferred<void>();
    const first = session({ reconnect: () => { requested.resolve(); return new Promise<string>(() => undefined); } });
    await first.start(new AbortController().signal);
    browser.disconnect();
    const controller = new AbortController();
    const dispatch = vi.fn(async () => undefined);
    const owner = expect(first.run(operation(1_000, controller.signal), 'owner', dispatch)).rejects.toMatchObject({ code: 'CANCELLED' });
    await requested.promise;
    const waiter = expect(first.run(operation(), 'waiter', dispatch)).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await Promise.all([owner, waiter]);
    expect(dispatch).not.toHaveBeenCalled();
    await first.close(cleanup());
  });

  it('subtracts endpoint resolution from both the CDP dial and dispatched operation budgets', async () => {
    const original = remote('current');
    const recovered = remote('current');
    vi.mocked(connectCdp).mockResolvedValueOnce(original.browser).mockResolvedValue(recovered.browser);
    const first = session({ reconnect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 'existing';
    } });
    await first.start(new AbortController().signal);
    original.disconnect();
    vi.useFakeTimers();
    vi.setTimerTickMode('nextTimerAsync');
    const dispatch = vi.fn(async (current) => current.timeoutMs as number);
    const remaining = await first.run(operation(200), 'read', dispatch);
    expect(vi.mocked(connectCdp).mock.calls[1]![1]).toBe(160);
    expect(remaining).toBe(160);
    await first.close(cleanup());
  });

  it('keeps late recording completion confined to the attempt that started it', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-attempt-recorder-'));
    const old = remote('old');
    const current = remote('current');
    const started = deferred<void>();
    const resume = deferred<void>();
    const firstPage = target('old-page').page;
    const nextPage = target('next-page').page;
    const nextStop = vi.fn(async () => undefined);
    Object.assign(firstPage, { screencast: {
      start: async ({ path: file }: { path: string }) => { writeFileSync(file, 'old'); started.resolve(); await resume.promise; },
      stop: async () => undefined,
    } });
    Object.assign(nextPage, { screencast: {
      start: async ({ path: file }: { path: string }) => { writeFileSync(file, 'next'); },
      stop: nextStop,
    } });
    old.pages.push(firstPage);
    current.pages.push(nextPage);
    vi.mocked(connectCdp).mockResolvedValueOnce(old.browser).mockResolvedValue(current.browser);
    const first = session({ artifactsDir: path.join(directory, 'old') });
    const next = session({ artifactsDir: path.join(directory, 'next') });
    try {
      await first.start(new AbortController().signal);
      const oldRecording = first.startVideo(new AbortController().signal);
      await started.promise;
      await first.close(cleanup());
      await next.start(new AbortController().signal);
      await next.startVideo(new AbortController().signal);
      resume.resolve();
      await oldRecording;
      await first.collectVideo(operation());
      expect(nextStop).not.toHaveBeenCalled();
      expect((await next.collectVideo(operation())).map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/video.webm']);
      expect(nextStop).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await first.close(cleanup());
      await next.close(cleanup());
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
