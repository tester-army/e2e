import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/index.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('browser.evaluate error boundaries', () => {
  let session: WebSession;
  let browser: Browser;

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 1_000, startAttempt: false });
  });

  beforeEach(async () => {
    await session.startAttempt();
    browser = session.browser;
    await session.setContent('<title>Evaluate</title>');
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
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

  it('keeps a call that outlives its budget as a timeout', async () => {
    await expect(browser.evaluate('() => new Promise(() => {})')).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringMatching(/^operation timed out/),
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
  });

  it.each(['restart', 'reset'] as const)('keeps a tab closed by %s during evaluation as infrastructure', async (replace) => {
    let dispatched!: () => void;
    const evaluating = new Promise<void>((resolve) => { dispatched = resolve; });
    session.serve('/evaluating', (_request, response) => {
      dispatched();
      response.end();
    });
    await session.setContent('<title>Pending</title>');
    const pending = browser.evaluate('() => { void fetch("/evaluating"); return new Promise(() => {}); }');
    const rejected = pending.catch((cause: unknown) => cause);
    await evaluating;
    await session.engine.session![replace]!(session.op());
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
    await session.setContent('<title>Cart</title>');
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
    await session.setContent('<div></div>');
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

  it('keeps evaluating once the page replaced Map', async () => {
    await session.setContent('<div>cart</div><script>window.Map = 1;</script>');
    await expect(browser.evaluate('() => 1')).resolves.toBe(1);
  });

  it('keeps locating once the page replaced Map', async () => {
    await session.setContent('<div>cart</div><script>window.Map = 1;</script>');
    await expect(session.locate({ kind: 'selector', selector: 'div' })).resolves.toHaveLength(1);
  });

  it('fails a locate as EVALUATE_FAILED once the page broke a Map method', async () => {
    await session.setContent('<div>cart</div><script>Map.prototype.set = 1;</script>');
    await expect(session.locate({ kind: 'selector', selector: 'div' })).rejects.toMatchObject({
      code: 'EVALUATE_FAILED',
      category: 'test',
      message: expect.stringContaining('the page deleted or replaced a JavaScript built-in'),
    });
  });

  it('runs keepNames output after the code deleted Object', async () => {
    await expect(browser.evaluate('() => { delete window.Object; return __name(() => 1, "pick").name; }')).resolves.toBe('pick');
  });

  it('keeps returning results on a page that deleted Array and JSON and hid __proto__', async () => {
    await session.setContent('<script>delete window.Array; delete window.JSON; delete Object.prototype.__proto__;</script>');
    await expect(browser.evaluate((n: number) => ({ items: [n, 'two'] }), 1)).resolves.toEqual({ items: [1, 'two'] });
    await expect(browser.evaluate('() => [1, 2]')).resolves.toEqual([1, 2]);
  });
});
