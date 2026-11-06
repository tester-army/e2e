import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { EngineFixtureContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

describe('browser.evaluate error boundaries', () => {
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-'));
  const signal = new AbortController().signal;
  let page: Page;
  let browser: Browser;

  beforeAll(async () => {
    await surface.init({ runId: 'evaluate', targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'evaluate', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
    browser = createBrowserFixture(surface, {
      operation: () => ({ signal, timeoutMs: 1_000, runId: 'evaluate', attemptId: 'evaluate', origin: 'test' }),
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
    ['() => { throw "cart is empty"; }', 'cart is empty'],
    ['() => { throw { message: "cart is empty" }; }', 'cart is empty'],
    ['() => { throw Object.create(null); }', 'Page evaluation threw an unprintable value'],
    ['() => { throw null; }', 'null'],
    ['() => { throw new Error("page.evaluate: Target closed"); }', 'page.evaluate: Target closed'],
  ])('preserves the message of a page exception: %s', async (source, message) => {
    await expect(browser.evaluate(source)).rejects.toMatchObject({ code: 'EVALUATE_FAILED', message });
  });

  it.each([
    'page.evaluate: Target page, context or browser has been closed',
    'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
  ])('keeps a Playwright rejection as infrastructure: %s', async (message) => {
    vi.spyOn(page, 'evaluateHandle').mockRejectedValueOnce(new Error(message));
    await expect(browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('keeps a Playwright timeout as OPERATION_TIMEOUT', async () => {
    const error = new Error('page.evaluate: Timeout 1000ms exceeded.');
    error.name = 'TimeoutError';
    vi.spyOn(page, 'evaluateHandle').mockRejectedValueOnce(error);
    await expect(browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it.each(['page', 'context'] as const)('keeps a real %s closure during evaluation as infrastructure', async (target) => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    await page.exposeFunction('__e2eReady', ready);
    const pending = browser.evaluate('async () => { await globalThis.__e2eReady(); await new Promise(() => {}); }');
    const rejected = pending.catch((cause: unknown) => cause);
    await started;
    if (target === 'page') await page.close();
    else await page.context().close();
    expect(await rejected).toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('preserves JSON results, explicit arguments, and zero-argument invocation', async () => {
    await expect(browser.evaluate((value: { count: number }) => ({ count: value.count + 1 }), { count: 4 }))
      .resolves.toEqual({ count: 5 });
    await expect(browser.evaluate('async () => ({ success: false, message: "ordinary data" })'))
      .resolves.toEqual({ success: false, message: 'ordinary data' });
    await expect(browser.evaluate('function () { return arguments.length; }')).resolves.toBe(0);
    await expect(browser.evaluate('function () { return arguments.length; }', null)).resolves.toBe(1);
  });

  it('evaluates a string as an expression and calls a function it evaluates to', async () => {
    await page.setContent('<title>Cart</title>');
    await expect(browser.evaluate('document.title')).resolves.toBe('Cart');
    await expect(browser.evaluate('(() => document.title)()')).resolves.toBe('Cart');
    await expect(browser.evaluate('fetch("data:text/plain,ok").then((response) => response.text())')).resolves.toBe('ok');
    await expect(browser.evaluate('(name) => document[name]', 'title')).resolves.toBe('Cart');
  });

  it('rejects invalid JSON results and syntax as test errors', async () => {
    await expect(browser.evaluate('() => Infinity')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(browser.evaluate('() => {')).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
    await expect(browser.evaluate('() => {', null)).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
    await expect(browser.evaluate('() => new Date()')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'evaluate result must be JSON-safe' });
    await expect(browser.evaluate('() => { try { document.querySelector("!!"); } catch (error) { return error; } }'))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'evaluate result must be JSON-safe' });
    await expect(browser.evaluate('() => ({ missing: undefined })')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(browser.evaluate('() => { const cart = {}; cart.self = cart; return cart; }')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'evaluate result contains a cycle' });
  });

  it('returns JSON only', async () => {
    await page.setContent('<div></div>');
    await expect(browser.evaluate('() => document.querySelector("div").getBoundingClientRect()'))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'evaluate result must be JSON-safe' });
    await expect(browser.evaluate('() => document.body')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(browser.evaluate('() => document.querySelector("div").getBoundingClientRect().toJSON()'))
      .resolves.toMatchObject({ width: expect.any(Number) });
    await expect(browser.evaluate('() => { const item = { sku: "a" }; return [item, item]; }'))
      .resolves.toEqual([{ sku: 'a' }, { sku: 'a' }]);
    await expect(browser.evaluate('() => "quote \\" line\\n\\u2028 \\ud83d\\ude00 lone \\ud800"'))
      .resolves.toBe('quote " line\n\u2028 \ud83d\ude00 lone \ud800');
  });

  it('returns a result after the page deletes or replaces the globals the transport could use', async () => {
    await expect(browser.evaluate(
      '() => { delete window.Array; window.Map = 1; window.JSON = 1; window.Object = 1; window.String = 1; return { items: [1, "two"], ok: true }; }',
    )).resolves.toEqual({ items: [1, 'two'], ok: true });
  });

  it('fails a later evaluate and a locate as EVALUATE_FAILED once the page replaced Map', async () => {
    await page.setContent('<div>cart</div><script>window.Map = 1;</script>');
    await expect(browser.evaluate('() => 1')).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
    const operation = { signal, timeoutMs: 5_000, runId: 'evaluate', attemptId: 'evaluate', origin: 'test' as const };
    await expect(surface.locate({ kind: 'selector', selector: 'div' }, operation))
      .rejects.toMatchObject({ code: 'EVALUATE_FAILED', category: 'test' });
  });

  it('runs keepNames output after the code deleted Object', async () => {
    await expect(browser.evaluate('() => { delete window.Object; return __name(() => 1, "pick").name; }')).resolves.toBe('pick');
  });

  it('keeps returning results on a page that deleted Array and JSON and hid __proto__', async () => {
    await page.setContent('<script>delete window.Array; delete window.JSON; delete Object.prototype.__proto__;</script>');
    await expect(browser.evaluate((n: number) => ({ items: [n, 'two'] }), 1)).resolves.toEqual({ items: [1, 'two'] });
    await expect(browser.evaluate('() => [1, 2]')).resolves.toEqual([1, 2]);
  });
});
