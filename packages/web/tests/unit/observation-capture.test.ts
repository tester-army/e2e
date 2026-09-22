import { tmpdir } from 'node:os';
import type { Browser, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import type { RawObservedNode } from '../../src/read-node.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { BrowserConnection } from '../../src/browser-connection.ts';

type ReadStage = 'evaluation' | 'metadata' | 'elements' | 'properties' | 'frame';
const surfaces = new Set<PlaywrightSurface>();

/** One externally completed protocol reply. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A document with real capture shapes and one optional stalled protocol boundary. */
function document(stalled?: ReadStage) {
  const gate = deferred();
  const checkpoint = async (stage: ReadStage) => { if (stalled === stage) await gate.promise; };
  const raw: RawObservedNode = {
    role: 'button', name: 'Button', labels: null, text: null, value: null,
    inputPurpose: 'none', attributes: {}, testId: 'button', parent: -1, level: null,
    states: { checked: null, disabled: false, selected: null, expanded: null, pressed: null, focused: false, hidden: false, secure: false },
    rect: { x: 0, y: 0, width: 100, height: 80 },
  };
  const element = {
    dispose: vi.fn(async () => undefined),
    asElement: () => element,
    contentFrame: vi.fn(async () => { await checkpoint('frame'); return null; }),
  };
  const elements = {
    dispose: vi.fn(async () => undefined),
    getProperties: vi.fn(async () => {
      await checkpoint('properties');
      return new Map([['0', element]]);
    }),
  };
  const captured = {
    dispose: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => {
      await checkpoint('metadata');
      return { nodes: [{ ...raw, ...(stalled === 'frame' ? { frameSelector: '#child' } : {}) }], ids: ['n1'], truncated: false };
    }),
    getProperty: vi.fn(async () => { await checkpoint('elements'); return elements; }),
  };
  const evaluateHandle = vi.fn(async () => { await checkpoint('evaluation'); return captured; });
  return { gate, captured, elements, element, evaluateHandle };
}

/** Opens an actual surface attempt through a scripted browser, retaining its real ref ownership. */
async function setup(stalled?: ReadStage) {
  const doc = document(stalled);
  const screenshot = vi.fn(async () => Buffer.from([1, 2, 3]));
  const count = vi.fn(async () => 0);
  const page = {
    isClosed: vi.fn(() => false),
    waitForLoadState: async () => undefined,
    viewportSize: () => ({ width: 100, height: 80 }),
    url: () => 'https://app.test',
    frames: () => [{ locator: () => ({ count }) }],
    evaluateHandle: doc.evaluateHandle,
    screenshot,
  };
  const context = {
    newPage: vi.fn(async (): Promise<Page> => page as unknown as Page),
    addInitScript: async () => undefined,
    setDefaultTimeout: () => undefined,
    on: () => undefined,
    close: async () => undefined,
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
  } as unknown as Browser;
  vi.spyOn(BrowserConnection.prototype, 'acquire').mockResolvedValue(browser);
  const controller = new AbortController();
  const operation: OperationContext = {
    signal: controller.signal, timeoutMs: 80, runId: 'run', attemptId: 'attempt', origin: 'agent',
  };
  const surface = new PlaywrightSurface({});
  surfaces.add(surface);
  await surface.init({
    runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {},
    headed: false, workerSlot: 0, signal: controller.signal, log: () => undefined,
  });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: controller.signal, registerSecret: () => undefined });
  await surface.ensurePage();
  return { ...doc, surface, page, context, screenshot, count, operation, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all([...surfaces].map((surface) => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1_000 })));
  surfaces.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('whole observation capture ownership', () => {
  it.each<ReadStage>(['evaluation', 'metadata', 'elements', 'properties', 'frame'])('recovers a stalled %s and disposes late handles', async (stage) => {
    const fixture = await setup(stage);
    const result = fixture.surface.observe(fixture.operation, { pixelFallback: true });
    await vi.advanceTimersByTimeAsync(60);
    expect((await result).treeUnavailable).toBe(true);
    expect(fixture.screenshot).toHaveBeenCalledOnce();
    fixture.gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.captured.dispose).toHaveBeenCalledOnce();
    if (stage === 'evaluation') expect(fixture.captured.evaluate).not.toHaveBeenCalled();
    if (stage === 'metadata') expect(fixture.captured.getProperty).not.toHaveBeenCalled();
    if (stage === 'elements') expect(fixture.elements.getProperties).not.toHaveBeenCalled();
    if (stage === 'properties' || stage === 'frame') expect(fixture.element.dispose).toHaveBeenCalledOnce();
  });

  it('times out stalled metadata within the operation budget when fallback is disabled', async () => {
    const fixture = await setup('metadata');
    const failure = expect(fixture.surface.observe(fixture.operation)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(80);
    await failure;
    expect(fixture.screenshot).not.toHaveBeenCalled();
    expect(fixture.captured.dispose).toHaveBeenCalledOnce();
    fixture.gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.captured.getProperty).not.toHaveBeenCalled();
  });

  it('does not spend the capture budget waiting for metadata disposal', async () => {
    const fixture = await setup();
    fixture.captured.dispose.mockImplementation(() => new Promise(() => undefined));
    fixture.elements.dispose.mockImplementation(() => new Promise(() => undefined));
    expect((await fixture.surface.observe(fixture.operation)).treeUnavailable).toBeUndefined();
    expect(fixture.captured.dispose).toHaveBeenCalledOnce();
    expect(fixture.element.dispose).not.toHaveBeenCalled();
  });

  it.each(['mask', 'screenshot'])('keeps a complete tree when optional %s capture exhausts its deadline', async (stage) => {
    const fixture = await setup();
    const gate = deferred();
    if (stage === 'mask') fixture.count.mockImplementation(async () => { await gate.promise; return 0; });
    else fixture.screenshot.mockImplementation(async () => { await gate.promise; return Buffer.from([1]); });
    const result = fixture.surface.observe(fixture.operation, { pixels: true });
    await vi.advanceTimersByTimeAsync(80);
    const snapshot = await result;
    expect(snapshot.treeUnavailable).toBeUndefined();
    expect(snapshot.pixels).toBeUndefined();
    expect(fixture.element.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (stage === 'mask') expect(fixture.screenshot).not.toHaveBeenCalled();
  });

  it('does not start a screenshot when cancelled mask probes eventually finish', async () => {
    const fixture = await setup();
    const gate = deferred();
    fixture.count.mockImplementation(async () => { await gate.promise; return 0; });
    const failure = expect(fixture.surface.observe(fixture.operation, { pixels: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    fixture.controller.abort();
    await failure;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.screenshot).not.toHaveBeenCalled();
    expect(fixture.element.dispose).toHaveBeenCalledOnce();
  });

  it('cannot publish an older capture over a newer observation on the same page', async () => {
    const fixture = await setup('metadata');
    const current = document();
    fixture.page.evaluateHandle.mockImplementationOnce(fixture.evaluateHandle.getMockImplementation()!)
      .mockImplementationOnce(current.evaluateHandle);
    const oldFailure = expect(fixture.surface.observe(fixture.operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    await vi.advanceTimersByTimeAsync(0);
    await fixture.surface.observe(fixture.operation);
    fixture.gate.resolve();
    await oldFailure;
    expect(fixture.element.dispose).toHaveBeenCalledOnce();
    expect(current.element.dispose).not.toHaveBeenCalled();
  });

  it('cannot publish a capture after its page was replaced', async () => {
    const fixture = await setup('metadata');
    const failure = expect(fixture.surface.observe(fixture.operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    await vi.advanceTimersByTimeAsync(0);
    fixture.page.isClosed.mockReturnValue(true);
    fixture.context.newPage.mockResolvedValue({ ...fixture.page, isClosed: () => false } as unknown as Page);
    await fixture.surface.ensurePage();
    fixture.gate.resolve();
    await failure;
    expect(fixture.element.dispose).toHaveBeenCalledOnce();
  });
});
