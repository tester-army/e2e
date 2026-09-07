import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { EngineFixtureContext } from '@e2edev/e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createWebFixture, type Web } from '../../src/web.ts';

describe('web.evaluate error boundaries', () => {
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-'));
  const signal = new AbortController().signal;
  let page: Page;
  let web: Web;

  beforeAll(async () => {
    await surface.init({ runId: 'evaluate', targetName: 'web', projectRoot: process.cwd(),
      app: { allowedOrigins: [] }, testIdAttribute: 'data-testid', headed: false, signal });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'evaluate', artifactsDir, signal });
    page = await surface.ensurePage();
    web = createWebFixture(surface, {
      operation: () => ({ signal, timeoutMs: 1_000, runId: 'evaluate', attemptId: 'evaluate' }),
      expectable: (target: object) => target,
      // The recorder is the harness's concern; these tests exercise evaluate's error boundaries only.
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it.each([
    ['() => { throw new Error("cart is empty"); }', 'cart is empty'],
    ['() => { throw new TypeError("cart is empty"); }', 'cart is empty'],
    ['async () => { throw new Error("cart is empty"); }', 'cart is empty'],
    ['() => { throw "cart is empty"; }', 'cart is empty'],
    ['() => { throw { message: "cart is empty" }; }', 'cart is empty'],
    ['() => { throw null; }', 'null'],
    ['() => { throw undefined; }', 'undefined'],
    ['() => { throw 42; }', '42'],
    ['() => { throw Object.create(null); }', 'Page evaluation threw an unprintable value'],
    ['() => { throw new Error("Execution context was destroyed"); }', 'Execution context was destroyed'],
    ['() => { throw new Error("page.evaluate: Target closed"); }', 'page.evaluate: Target closed'],
  ])('preserves the message of a page exception: %s', async (source, message) => {
    await expect(web.evaluate(source)).rejects.toMatchObject({ code: 'EVALUATE_FAILED', message });
  });

  it.each([
    'page.evaluate: Target page, context or browser has been closed',
    'page.evaluate: Target closed',
    'page.evaluate: Page crashed',
    'page.evaluate: Cannot find context with specified id',
    'page.evaluate: Protocol error (Runtime.callFunctionOn): Target closed',
    'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
  ])('keeps a Playwright rejection as infrastructure: %s', async (message) => {
    vi.spyOn(page, 'evaluate').mockRejectedValueOnce(new Error(message));
    await expect(web.evaluate('() => 1')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('keeps a Playwright timeout as OPERATION_TIMEOUT', async () => {
    const error = new Error('page.evaluate: Timeout 1000ms exceeded.');
    error.name = 'TimeoutError';
    vi.spyOn(page, 'evaluate').mockRejectedValueOnce(error);
    await expect(web.evaluate('() => 1')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it.each(['page', 'context'] as const)('keeps a real %s closure during evaluation as infrastructure', async (target) => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    await page.exposeFunction('__e2eReady', ready);
    const pending = web.evaluate('async () => { await globalThis.__e2eReady(); await new Promise(() => {}); }');
    const rejected = pending.catch((cause: unknown) => cause);
    await started;
    if (target === 'page') await page.close();
    else await page.context().close();
    expect(await rejected).toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('preserves JSON results, explicit arguments, and zero-argument invocation', async () => {
    await expect(web.evaluate((value: { count: number }) => ({ count: value.count + 1 }), { count: 4 }))
      .resolves.toEqual({ count: 5 });
    await expect(web.evaluate('async () => ({ success: false, message: "ordinary data" })'))
      .resolves.toEqual({ success: false, message: 'ordinary data' });
    await expect(web.evaluate('function () { return arguments.length; }')).resolves.toBe(0);
    await expect(web.evaluate('function () { return arguments.length; }', null)).resolves.toBe(1);
  });

  it('rejects invalid JSON results and syntax as test errors', async () => {
    await expect(web.evaluate('() => Infinity')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(web.evaluate('() => {')).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
    await expect(web.evaluate('() => {', null)).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
  });
});
