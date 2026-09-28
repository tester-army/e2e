/** Attempt transitions isolate callbacks and retain finalized artifacts after setup failure. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Dialog, Route } from 'playwright';
import type { EngineFixtureContext, OperationContext } from 'e2e/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createWebFixture } from '../../src/web.ts';

const acquire = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', () => ({
  BrowserConnection: class { acquire = acquire; dispose = async () => undefined; },
  connectCdp: vi.fn(),
}));

const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
let artifactsDir: string;
let surface: PlaywrightSurface;
let registered: ((route: Route) => Promise<void>) | undefined;
let browser: Browser;
let focus: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let press: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
let type: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(async () => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-surface-lifecycle-'));
  registered = undefined;
  focus = vi.fn(async () => true);
  press = vi.fn(async (_key: string) => undefined);
  type = vi.fn(async (_text: string) => undefined);
  const page = {
    isClosed: () => false,
    close: async () => undefined,
    goto: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
    frames: () => [{ evaluate: focus }],
    keyboard: { press, type },
    screencast: {
      start: async ({ path: file }: { path: string }) => { writeFileSync(file, 'recording'); },
      stop: async () => undefined,
    },
  };
  browser = {
    isConnected: () => true,
    newContext: vi.fn(async () => ({
      addInitScript: async () => undefined,
      setDefaultTimeout: () => undefined,
      on: () => undefined,
      route: async (_predicate: unknown, handler: (route: Route) => Promise<void>) => { registered = handler; },
      close: async () => undefined,
      newPage: async () => page,
      tracing: {
        start: async () => undefined,
        stop: async (options?: { path: string }) => { if (options !== undefined) writeFileSync(options.path, 'trace'); },
      },
    })),
  } as unknown as Browser;
  acquire.mockResolvedValue(browser);
  surface = new PlaywrightSurface({});
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal });
});

afterEach(async () => {
  await surface.dispose(cleanup());
  rmSync(artifactsDir, { recursive: true, force: true });
});

it.each(['dialog', 'route'] as const)('keeps a late %s failure on the attempt that registered it', async (kind) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const oldLatch = surface.latch;
  let pending: Promise<void>;
  if (kind === 'dialog') {
    surface.dialogs.add(async () => { await waiting; throw new Error('old handler failed'); });
    pending = surface.dialogs.dispatch({ type: () => 'confirm', message: () => 'old', dismiss: async () => undefined } as unknown as Dialog);
  } else {
    const web = createWebFixture(surface, {
      operation,
      fixture: (_name: string, value: unknown) => value,
      expectable: (value: unknown) => value,
      app: { resolveUrl: (url: string) => url },
    } as unknown as EngineFixtureContext);
    await web.route('**/*', async () => { await waiting; throw new Error('old handler failed'); });
    pending = registered!({
      request: () => ({ postData: () => null, url: () => 'https://example.test/', method: () => 'GET', headers: () => ({}) }),
      abort: async () => undefined,
    } as unknown as Route);
  }
  await surface.endAttempt(cleanup());
  await surface.startAttempt({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
  release();
  await pending;
  expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
  await expect(surface.guard(operation(), 'next attempt', async () => 'clean')).resolves.toBe('clean');
});

it('collects saved trace and video segments after ordinary context replacement fails', async () => {
  await surface.startVideo(operation());
  await surface.startTrace(operation());
  vi.mocked(browser.newContext).mockRejectedValueOnce(new Error('replacement failed'));
  await expect(surface.reset(operation())).rejects.toThrow(/replacement failed/);
  await expect(surface.stopTrace(operation())).resolves.toEqual(['trace/trace-part1.zip']);
  const video = await surface.stopVideo(operation());
  expect(video.map((segment) => segment.path)).toEqual(['video/video.webm']);
  expect(readFileSync(path.join(artifactsDir, 'trace/trace-part1.zip'), 'utf8')).toBe('trace');
  expect(readFileSync(path.join(artifactsDir, video[0]!.path), 'utf8')).toBe('recording');
  await expect(surface.open('https://example.test/', operation())).rejects.toThrow(/replacement failed/);
});

it.each(['focus', 'select-all', 'delete'] as const)('stops remaining typing after cancellation during %s', async (stage) => {
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  if (stage === 'focus') {
    focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  } else {
    press.mockImplementation(async (key) => {
      if (key === (stage === 'select-all' ? 'ControlOrMeta+A' : 'Delete')) { entered(); await paused; }
    });
  }
  const controller = new AbortController();
  const pending = surface.typeText('replacement', { replace: true }, { ...operation(), signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  try {
    await reached;
    controller.abort();
    await rejected;
  } finally {
    release();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const expected = stage === 'focus' ? [] : stage === 'select-all' ? ['ControlOrMeta+A'] : ['ControlOrMeta+A', 'Delete'];
  expect(press.mock.calls.map(([key]) => key)).toEqual(expected);
  expect(type).not.toHaveBeenCalled();
});

it('rejects a focus read from a context replaced before typing dispatches', async () => {
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  const pending = surface.typeText('replacement', { replace: true }, operation());
  const rejected = expect(pending).rejects.toMatchObject({ code: 'NODE_STALE' });
  try {
    await reached;
    await surface.reset(operation());
  } finally {
    release();
  }
  await rejected;
  expect(press).not.toHaveBeenCalled();
  expect(type).not.toHaveBeenCalled();
});
