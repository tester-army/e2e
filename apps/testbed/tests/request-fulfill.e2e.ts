/**
 * Adapted from microsoft/playwright tests/page/page-request-fulfill.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a navigation's response is the one `browser.waitForResponse` sees.
 */

/*
 * Not ported:
 * - should allow mocking binary responses: needs `toMatchSnapshot`.
 * - should fulfill with global fetch result: needs `playwright.request` and `fulfill({ response })`.
 * - should fulfill with fetch result: needs `page.request` and `fulfill({ response })`.
 * - should fulfill with fetch result and overrides: needs `page.request` and `fulfill({ response })`.
 * - headerValue should return set-cookie from intercepted response: Playwright expects it to fail on Chromium.
 * - should fulfill with har response: HAR.
 * - should fulfill with gzip and readback: needs a gzip server and `fulfill({ response })`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { asset, content, CROSS, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

/** A promise with its resolver, for a route handler the test holds open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Polls the page until `expression` is truthy, Playwright's `page.waitForFunction`. */
const waitForFunction = (expression: string): string =>
  `() => new Promise((resolve) => { const check = () => (${expression}) ? resolve(true) : setTimeout(check, 20); check(); })`;

test.describe('page request fulfill', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.route('**/*', (route) => route.fulfill({ status: 201, headers: { foo: 'bar' }, contentType: 'text/html', body: 'Yo, page!' }));
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(response.status).toBe(201);
    expect(response.headers['foo']).toBe('bar');
    expect(await browser.evaluate('() => document.body.textContent')).toBe('Yo, page!');
  });

  test('should work with buffer as body', async ({ browser }) => {
    await browser.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: Buffer.from('Yo, page!') }));
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(response.status).toBe(200);
    expect(await browser.evaluate('() => document.body.textContent')).toBe('Yo, page!');
  });

  test('should work with status code 422', async ({ browser }) => {
    await browser.route('**/*', (route) => route.fulfill({ status: 422, body: 'Yo, page!' }));
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(response.status).toBe(422);
    expect(await browser.evaluate('() => document.body.textContent')).toBe('Yo, page!');
  });

  test('should fulfill with unuassigned status codes', async ({ browser }) => {
    const fulfilled = deferred<Error | undefined>();
    await browser.route('**/data.json', async (route) => {
      fulfilled.resolve(await route.fulfill({ status: 430, body: 'Yo, page!' }).then(() => undefined, (caught: Error) => caught));
    });
    await browser.goto(EMPTY_PAGE);
    const response = await browser.evaluate<{ status: number; statusText: string }, string>(
      'async (url) => { const { status, statusText } = await fetch(url); return { status, statusText }; }',
      `${PREFIX}/data.json`,
    );
    const error = await fulfilled.promise;
    expect(error).toBe(undefined);
    expect(response.status).toBe(430);
    expect(response.statusText).toBe('Unknown');
  });

  test('should not throw if request was cancelled by the page', async ({ browser }) => {
    const routed = deferred();
    const release = deferred();
    await browser.route('**/data.json', async (route) => {
      routed.resolve();
      await release.promise;
      await route.fulfill({ status: 200 });
    });
    await browser.goto(EMPTY_PAGE);
    await browser.evaluate(`(url) => {
      globalThis.controller = new AbortController();
      globalThis.failure = fetch(url, { signal: globalThis.controller.signal }).then(() => 'loaded', (error) => error.name);
    }`, `${PREFIX}/data.json`);
    await routed.promise;
    expect(await browser.evaluate('() => { globalThis.controller.abort(); return globalThis.failure; }')).toBe('AbortError');
    release.resolve();
    await browser.evaluate('() => new Promise((resolve) => setTimeout(resolve, 100))');
  });

  test('should allow mocking svg with charset', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/*', (route) => route.fulfill({
      contentType: 'image/svg+xml ; charset=utf-8',
      body: '<svg width="50" height="50" version="1.1" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="30" height="30" stroke="black" fill="transparent" stroke-width="5"/></svg>',
    }));
    const size = await browser.evaluate(`(PREFIX) => {
      const img = document.createElement('img');
      img.src = PREFIX + '/does-not-exist.svg';
      document.body.appendChild(img);
      return new Promise((resolve, reject) => { img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = reject; });
    }`, PREFIX);
    expect(size).toEqual([50, 50]);
  });

  test('should work with file path', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/*', (route) => route.fulfill({ contentType: 'shouldBeIgnored', path: asset('pptr.png') }));
    const size = await browser.evaluate(`(PREFIX) => {
      const img = document.createElement('img');
      img.src = PREFIX + '/does-not-exist.png';
      document.body.appendChild(img);
      return new Promise((resolve) => { img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); });
    }`, PREFIX);
    expect(size).toEqual([69, 100]);
  });

  test('should stringify intercepted request response headers', async ({ browser }) => {
    await browser.route('**/*', (route) => route.fulfill({ status: 200, headers: { foo: 'true' }, body: 'Yo, page!' }));
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(response.status).toBe(200);
    expect(response.headers['foo']).toBe('true');
    expect(await browser.evaluate('() => document.body.textContent')).toBe('Yo, page!');
  });

  test('should not modify the headers sent to the server', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.route(`${PREFIX}/unused`, (route) => route.continue());
    const fetchServed = 'async (url) => { const data = await fetch(url); return data.text(); }';
    const served = await browser.evaluate<string, string>(fetchServed, `${CROSS}/cors-echo`);
    const before = JSON.parse(served) as { method: string; headers: Record<string, string> };
    expect(before.method).toBe('GET');

    await browser.route(`${CROSS}/cors-echo`, (route) => route.continue({ headers: { ...route.request.headers } }));
    const servedAfterRoute = await browser.evaluate<string, string>(fetchServed, `${CROSS}/cors-echo`);
    const after = JSON.parse(servedAfterRoute) as { method: string; headers: Record<string, string> };
    expect(after.method).toBe('GET');
    expect(after.headers).toEqual(before.headers);
  });

  test('should include the origin header', async ({ browser }) => {
    await browser.goto('/empty.html');
    let origin: string | undefined;
    await browser.route(`${CROSS}/something`, async (route) => {
      origin = route.request.headers['origin'];
      await route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/plain', body: 'done' });
    });
    const text = await browser.evaluate('async (url) => { const data = await fetch(url); return data.text(); }', `${CROSS}/something`);
    expect(text).toBe('done');
    expect(origin).toEqual(PREFIX);
  });

  test('should fetch original request and fulfill', async ({ browser }) => {
    await browser.route('**/*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ status: response.status, headers: { ...response.headers }, body: await response.text() });
    });
    const [response] = await Promise.all([browser.waitForResponse('**/title.html'), browser.goto('/title.html')]);
    expect(response.status).toBe(200);
    expect(await browser.title()).toEqual('Woof-Woof');
  });

  test('should fulfill with multiple set-cookie', async ({ browser }) => {
    const cookies = ['a=b', 'c=d'];
    await browser.route('**/multiple-set-cookie.html', (route) => route.fulfill({
      status: 200,
      headers: { 'X-Header-1': 'v1', 'Set-Cookie': cookies.join('\n'), 'X-Header-2': 'v2' },
      body: '',
    }));
    const [response] = await Promise.all([
      browser.waitForResponse('**/multiple-set-cookie.html'),
      browser.goto('/multiple-set-cookie.html'),
    ]);
    const cookie = await browser.evaluate<string>('() => document.cookie');
    expect(cookie.split(';').map((s) => s.trim()).toSorted()).toEqual(cookies);
    expect(response.headers['x-header-1']).toBe('v1');
    expect(response.headers['x-header-2']).toBe('v2');
  });

  test('should fulfill with fetch response that has multiple set-cookie', async ({ browser }) => {
    await browser.route('**/respond?*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ status: response.status, headers: { ...response.headers }, body: await response.text() });
    });
    const headers = JSON.stringify({ 'set-cookie': ['a=b', 'c=d'], 'content-type': 'text/html' });
    await browser.goto(`/respond?headers=${encodeURIComponent(headers)}`);
    const cookie = await browser.evaluate<string>('() => document.cookie');
    expect(cookie.split(';').map((s) => s.trim()).toSorted()).toEqual(['a=b', 'c=d']);
  });

  test('should fulfill preload link requests', async ({ browser }) => {
    let intercepted = false;
    await browser.route('**/one-style.css', async (route) => {
      intercepted = true;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache, no-store', custom: 'value' },
        body: 'body { background-color: green; }',
      });
    });
    const [response] = await Promise.all([browser.waitForResponse('**/one-style.css'), browser.goto('/preload.html')]);
    expect(response.headers['custom']).toBe('value');
    await browser.evaluate(waitForFunction('window.preloadedStyles'));
    expect(intercepted).toBe(true);
    // preload.html sets the flag before switching the link to a stylesheet, which applies a task later.
    await expect.poll(() => browser.evaluate('() => window.getComputedStyle(document.body).backgroundColor')).toBe('rgb(0, 128, 0)');
  });

  test('should fulfill json', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/data.json', (route) => route.fulfill({ status: 201, headers: { foo: 'bar' }, json: { bar: 'baz' } }));
    const [response, body] = await Promise.all([
      browser.waitForResponse('**/*'),
      browser.evaluate("() => fetch('./data.json').then((r) => r.text())"),
    ]);
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('application/json');
    expect(body).toBe(JSON.stringify({ bar: 'baz' }));
  });

  test('should not go to the network for fulfilled requests body', async ({ browser }) => {
    const key = `fulfilled-${Date.now()}-${Math.random()}`;
    await browser.route(`**/count?key=${key}`, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found! (mocked)' }));
    const [response] = await Promise.all([
      browser.waitForResponse(`**/count?key=${key}`),
      browser.goto(content(`<link rel="stylesheet" href="/count?key=${key}"><div>hello, world!</div>`)),
    ]);
    expect(await response.text()).toBe('Not Found! (mocked)');
    await browser.unrouteAll();
    const serverHits = await browser.evaluate("(key) => fetch('/count?key=' + key).then((r) => r.text())", key);
    expect(serverHits).toBe('11');
  });

  test('should return body for fulfilled responses', async ({ browser }) => {
    for (const status of [100, 200, 404, 500]) {
      const bodyOverride = `Custom body ${status}`;
      await browser.route('**/one-style.css', (route) => route.fulfill({ status, contentType: 'text/plain', body: bodyOverride }));
      const [response] = await Promise.all([browser.waitForResponse('**/one-style.css'), browser.goto('/one-style.html')]);
      expect(await response.text()).toBe(bodyOverride);
      await browser.unrouteAll();
    }
  });
});
