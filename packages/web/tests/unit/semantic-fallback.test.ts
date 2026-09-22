import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, ElementHandle, Page } from 'playwright';
import { EngineError, TestError, type OperationContext } from 'e2e/engine';
import { captureDocument, ROOT_NODE_ID } from '../../src/observation.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { BrowserConnection } from '../../src/browser-connection.ts';

vi.mock('../../src/observation.ts', async (original) => ({
  ...await original<typeof import('../../src/observation.ts')>(),
  captureDocument: vi.fn(),
}));

const TIMEOUT = new EngineError('OPERATION_TIMEOUT', 'semantic reader timed out', { retryable: false });
const surfaces = new Set<PlaywrightSurface>();
const operation = (signal = new AbortController().signal): OperationContext => ({
  signal, timeoutMs: 1_000, runId: 'run', attemptId: 'attempt', origin: 'agent',
});

/** Opens an actual attempt whose independent mask probes can fail without a semantic reader. */
async function setup() {
  const masks = [
    { count: vi.fn(async () => 1) },
    { count: vi.fn(async () => 0) },
  ];
  const screenshot = vi.fn(async (_options: unknown) => Buffer.from([1, 2, 3]));
  const page = {
    isClosed: () => false,
    waitForLoadState: async () => undefined,
    viewportSize: () => ({ width: 100, height: 80 }),
    url: () => 'https://app.test/current',
    frames: () => [{ locator: (selector: string) => selector.startsWith('e2e-closed') ? masks[1] : masks[0] }],
    screenshot,
  } as unknown as Page;
  const browser = {
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => page,
      addInitScript: async () => undefined,
      setDefaultTimeout: () => undefined,
      on: () => undefined,
      close: async () => undefined,
    }),
  } as unknown as Browser;
  vi.spyOn(BrowserConnection.prototype, 'acquire').mockResolvedValue(browser);
  const surface = new PlaywrightSurface({});
  surfaces.add(surface);
  const signal = new AbortController().signal;
  await surface.init({
    runId: 'run', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {},
    headed: false, workerSlot: 0, signal, log: () => undefined,
  });
  await surface.startAttempt({ attemptId: 'attempt', artifactsDir: tmpdir(), signal, registerSecret: () => undefined });
  await surface.ensurePage();
  vi.mocked(captureDocument).mockRejectedValue(TIMEOUT);
  return { surface, masks, screenshot };
}

afterEach(async () => {
  await Promise.all([...surfaces].map((surface) => surface.dispose({ signal: new AbortController().signal, timeoutMs: 1_000 })));
  surfaces.clear();
  vi.restoreAllMocks();
});

describe('semantic capture fallback', () => {
  it('takes fresh masked pixels after a timeout, retires old refs, and reports unavailable semantics', async () => {
    const { surface, screenshot } = await setup();
    const dispose = vi.fn(async () => undefined);
    vi.mocked(captureDocument).mockImplementationOnce(async (deps) => {
      deps.commit('old', { dispose } as unknown as ElementHandle<Element>);
      return { tree: { ref: { id: ROOT_NODE_ID, revision: '' } }, truncated: false, nodeCount: 1 };
    });
    await surface.observe(operation());
    const result = await surface.observe(operation(), { pixels: true, pixelFallback: true });
    expect(result.treeUnavailable).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.root).toEqual({ ref: { id: ROOT_NODE_ID, revision: '' } });
    expect(result.pixels?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(screenshot.mock.calls[1]?.[0]).toMatchObject({ maskColor: '#000000', mask: expect.any(Array) });
    expect(dispose).toHaveBeenCalledOnce();
    await expect(surface.perform({ id: 'old', revision: 'r1' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('recovers the initial tree-only capture when the caller permits pixels', async () => {
    const { surface, screenshot } = await setup();
    expect((await surface.observe(operation(), { pixelFallback: true })).treeUnavailable).toBe(true);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it('fails closed when a mask probe cannot prove coverage', async () => {
    const { surface, masks } = await setup();
    masks[0]!.count.mockRejectedValue(new Error('frame detached'));
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(TIMEOUT);
  });

  it('does not turn an ordinary tree-only request into a screenshot', async () => {
    const { surface, screenshot } = await setup();
    await expect(surface.observe(operation())).rejects.toBe(TIMEOUT);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('preserves the fallback reserve when a concurrent pixel mask probe stalls', async () => {
    const { surface, masks, screenshot } = await setup();
    masks[0]!.count.mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(captureDocument).mockImplementation(async (_deps, _host, options) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, options.deadline - Date.now())));
      throw TIMEOUT;
    });
    const captured = await surface.observe(operation(), { pixels: true, pixelFallback: true });
    expect(captured.treeUnavailable).toBe(true);
    expect(screenshot).toHaveBeenCalledOnce();
  });

  it('preserves a hard failure from the fallback screenshot', async () => {
    const { surface, screenshot } = await setup();
    const error = new TestError('POLICY_DENIED', 'pixels denied');
    screenshot.mockRejectedValue(error);
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(error);
  });

  it.each(['POLICY_DENIED', 'INVALID_STATE', 'NODE_STALE', 'CANCELLED'] as const)('preserves %s instead of falling back', async (code) => {
    const { surface, screenshot } = await setup();
    const error = code === 'POLICY_DENIED' ? new TestError(code, 'stop') : new EngineError(code, 'stop', { retryable: false });
    vi.mocked(captureDocument).mockRejectedValue(error);
    await expect(surface.observe(operation(), { pixelFallback: true })).rejects.toBe(error);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('preserves cancellation while the fallback screenshot is in flight', async () => {
    const { surface, screenshot } = await setup();
    const controller = new AbortController();
    screenshot.mockImplementation(async () => { controller.abort(); return Buffer.from([1]); });
    await expect(surface.observe(operation(controller.signal), { pixelFallback: true })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
