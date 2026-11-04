/**
 * Adapted from microsoft/playwright tests/page/page-route.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a navigation's response is the one `browser.waitForResponse` sees.
 */

/*
 * Not ported:
 * - should navigate to dataURL and not fire dataURL requests: `goto` refuses `data:` URLs on purpose.
 * - should show custom HTTP headers: needs `page.setExtraHTTPHeaders`.
 * - should work with custom referer headers: needs `page.setExtraHTTPHeaders`.
 * - should send referer: needs `page.setExtraHTTPHeaders`.
 * - should be abortable with custom error codes: needs `route.abort(errorCode)` and `requestfailed`.
 * - should chain fallback w/ dynamic URL: needs `route.fallback({ url })`.
 * - should not fulfill with redirect status: WebKit only.
 * - should support the times parameter with route matching: needs `route(..., { times })`.
 * - should work if handler with times parameter was removed from another handler: needs `route(..., { times })`.
 * - should support async handler w/ times: needs `route(..., { times })`.
 * - route abort with times: 1 should not affect second sequential fetch: needs `route(..., { times })` and `route.abort(errorCode)`.
 * - should contain sec-fetch headers in route: needs `request.allHeaders()`, and fails on Chromium by design.
 * - should contain raw response header: needs `request.response()`.
 * - should contain raw response header after fulfill: needs `request.response()`.
 * - should be able to intercept every navigation to a page controlled by service worker: service workers.
 * - should respect URLPattern ignoreCase: `route` takes a glob or RegExp, not a URLPattern.
 * - should not support ? in glob pattern: `?` in a route glob matches one character on purpose, where Playwright reads it literally.
 */

import { test, type WebRoute } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

/** A promise with its resolver, for a route handler the test holds open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test.describe('page route', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should intercept @smoke', async ({ browser }) => {
    let intercepted = false;
    await browser.route('**/empty.html', async (route) => {
      expect(route.request.url).toContain('empty.html');
      expect(route.request.headers['user-agent']).toBeTruthy();
      expect(route.request.method).toBe('GET');
      expect(route.request.postData).toBe(undefined);
      await route.continue();
      intercepted = true;
    });
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(EMPTY_PAGE)]);
    expect(response.status).toBe(200);
    expect(intercepted).toBe(true);
  });

  test('should unroute', async ({ browser }) => {
    let intercepted: number[] = [];
    await browser.route('**/*', async (route) => {
      intercepted.push(1);
      await route.fallback();
    });
    await browser.route('**/empty.html', async (route) => {
      intercepted.push(2);
      await route.fallback();
    });
    await browser.route('**/empty.html', async (route) => {
      intercepted.push(3);
      await route.fallback();
    });
    await browser.route(/empty.html/, async (route) => {
      intercepted.push(4);
      await route.fallback();
    });
    await browser.goto(EMPTY_PAGE);
    expect(intercepted).toEqual([4, 3, 2, 1]);

    intercepted = [];
    await browser.unroute(/empty.html/);
    await browser.goto(EMPTY_PAGE);
    expect(intercepted).toEqual([3, 2, 1]);

    intercepted = [];
    await browser.unroute('**/empty.html');
    await browser.goto(EMPTY_PAGE);
    expect(intercepted).toEqual([1]);
  });

  test('should work when POST is redirected with 302', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/*', (route) => route.continue());
    await browser.goto(content(`
      <form action='/redirect?to=/empty.html' method='post'>
        <input type="hidden" id="foo" name="foo" value="FOOBAR">
      </form>
    `));
    await Promise.all([
      browser.evaluate("() => { document.querySelector('form').submit(); }"),
      browser.waitForURL('/empty.html'),
    ]);
  });

  test('should work when header manipulation headers with redirect', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue({ headers: { ...route.request.headers, foo: 'bar' } }));
    await browser.goto('/redirect?to=/empty.html');
  });

  test('should be able to remove headers', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/*', async (route) => {
      const headers = { ...route.request.headers };
      delete headers['foo'];
      await route.continue({ headers });
    });
    const served = await browser.evaluate<{ headers: Record<string, string> }, string>(
      "(url) => fetch(url, { headers: { foo: 'bar' } }).then((response) => response.json())",
      `${PREFIX}/cors-echo`,
    );
    expect(served.headers['foo']).toBe(undefined);
  });

  test('should contain referer header', async ({ browser }) => {
    const requests: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      requests.push(route.request);
      await route.continue();
    });
    await browser.goto('/one-style.html');
    expect(requests[1]!.url).toContain('/one-style.css');
    expect(requests[1]!.headers['referer']).toContain('/one-style.html');
  });

  test('should properly return navigation response when URL has cookies', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.setCookies([{ url: EMPTY_PAGE, name: 'foo', value: 'bar' }]);
    await browser.route('**/*', (route) => route.continue());
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.reload()]);
    expect(response.status).toBe(200);
  });

  test('should not override cookie header', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.evaluate("() => { document.cookie = 'original=value'; }");
    let cookieValueInRoute: string | undefined;
    await browser.route('**', async (route) => {
      const headers = { ...route.request.headers };
      cookieValueInRoute = headers['cookie'];
      headers['cookie'] = 'overridden=value';
      await route.continue({ headers });
    });
    await browser.goto('/cors-echo');
    const served = JSON.parse(await browser.evaluate<string>('document.body.textContent')) as { headers: Record<string, string> };
    expect(cookieValueInRoute).toBe('original=value');
    expect(served.headers['cookie']).toBe('original=value');
  });

  test('should work with redirect inside sync XHR', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    let continued = false;
    await browser.route('**/*', async (route) => {
      await route.continue();
      continued = true;
    });
    const status = await browser.evaluate(`() => {
      const request = new XMLHttpRequest();
      request.open('GET', '/redirect?to=/pptr.png', false);
      request.send(null);
      return request.status;
    }`);
    expect(status).toBe(200);
    expect(continued).toBe(true);
  });

  test('should pause intercepted XHR until continue', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const routed = deferred();
    const release = deferred();
    await browser.route('**/global-var.html', async (route) => {
      routed.resolve();
      await release.promise;
      await route.continue();
    });
    let xhrFinished = false;
    const statusPromise = browser.evaluate(`() => {
      const request = new XMLHttpRequest();
      request.open('GET', '/global-var.html', false);
      request.send(null);
      return request.status;
    }`).then((status) => {
      xhrFinished = true;
      return status;
    });
    await routed.promise;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(xhrFinished).toBe(false);
    release.resolve();
    expect(await statusPromise).toBe(200);
  });

  test('should pause intercepted fetch request until continue', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const routed = deferred();
    const release = deferred();
    await browser.route('**/global-var.html', async (route) => {
      routed.resolve();
      await release.promise;
      await route.continue();
    });
    let fetchFinished = false;
    const statusPromise = browser.evaluate("async () => (await fetch('/global-var.html')).status").then((status) => {
      fetchFinished = true;
      return status;
    });
    await routed.promise;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fetchFinished).toBe(false);
    release.resolve();
    expect(await statusPromise).toBe(200);
  });

  test('should be abortable', async ({ browser }) => {
    await browser.route(/\.css$/, (route) => route.abort());
    const [response] = await Promise.all([browser.waitForResponse('**/one-style.html'), browser.goto('/one-style.html')]);
    expect(response.status).toBe(200);
    expect(await browser.evaluate('getComputedStyle(document.body).backgroundColor')).not.toBe('rgb(255, 192, 203)');
  });

  test('should not throw if request was cancelled by the page', async ({ browser }) => {
    const routed = deferred();
    const release = deferred();
    await browser.route('**/data.json', async (route) => {
      routed.resolve();
      await release.promise;
      await route.abort();
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

  test('should fail navigation when aborting main resource', async ({ browser }) => {
    await browser.route('**/*', (route) => route.abort());
    const error = await browser.goto(EMPTY_PAGE).catch((caught: Error) => caught);
    expect(error).toBeTruthy();
    expect((error as Error).message).toContain('net::ERR_FAILED');
  });

  test('should not work with redirects', async ({ browser }) => {
    const intercepted: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      await route.continue();
      intercepted.push(route.request);
    });
    const chain = ['/non-existing-page.html', '/non-existing-page-2.html', '/non-existing-page-3.html', '/non-existing-page-4.html'];
    const start = chain.reduceRight((to, from) => `/redirect?from=${from}&to=${encodeURIComponent(to)}`, '/empty.html');
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(start)]);
    expect(response.status).toBe(200);
    expect(response.url).toContain('empty.html');

    expect(intercepted.length).toBe(1);
    expect(intercepted[0]!.url).toContain('/non-existing-page.html');
  });

  test('should work with redirects for subresources', async ({ browser }) => {
    const intercepted: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      await route.continue();
      intercepted.push(route.request);
    });
    const chain = ['/one-style.css', '/two-style.css', '/three-style.css'];
    const stylesheet = chain.reduceRight((to, from) => `/redirect?from=${from}&to=${encodeURIComponent(to)}`, '/one-style.css');
    const page = content(`<link rel="stylesheet" href="${stylesheet}"><div>hello, world!</div>`);
    const [response] = await Promise.all([browser.waitForResponse('**/content?**'), browser.goto(page)]);
    expect(response.status).toBe(200);
    expect(response.url).toContain('/content?');

    expect(intercepted.length).toBe(2);
    expect(intercepted[0]!.url).toContain('/content?');
    expect(intercepted[1]!.url).toContain('/one-style.css');
  });

  test('should work with equal requests', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const key = `equal-${Date.now()}-${Math.random()}`;
    let spinner = false;
    await browser.route('**/*', async (route) => {
      await (spinner ? route.abort() : route.continue());
      spinner = !spinner;
    });
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await browser.evaluate("(key) => fetch('/count?key=' + key).then((response) => response.text()).catch(() => 'FAILED')", key));
    }
    expect(results).toEqual(['11', 'FAILED', '22']);
  });

  test('should be able to fetch dataURL and not fire dataURL requests', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const requests: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      requests.push(route.request);
      await route.continue();
    });
    const text = await browser.evaluate('(url) => fetch(url).then((response) => response.text())', 'data:text/html,<div>yo</div>');
    expect(text).toBe('<div>yo</div>');
    expect(requests.length).toBe(0);
  });

  test('should navigate to URL with hash and and fire requests without hash', async ({ browser }) => {
    const requests: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      requests.push(route.request);
      await route.continue();
    });
    const [response] = await Promise.all([browser.waitForResponse('**/empty.html'), browser.goto(`${EMPTY_PAGE}#hash`)]);
    expect(response.status).toBe(200);
    expect(response.url).toBe(EMPTY_PAGE);
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe(EMPTY_PAGE);
  });

  test('should work with encoded server', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue());
    const [response] = await Promise.all([browser.waitForResponse(/nonexisting/), browser.goto(`${PREFIX}/some nonexisting page`)]);
    expect(response.status).toBe(404);
  });

  test('should work with badly encoded server', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue());
    const [response] = await Promise.all([browser.waitForResponse(/rnd=/), browser.goto(`${PREFIX}/status?rnd=%911`)]);
    expect(response.status).toBe(200);
  });

  test('should work with encoded server - 2', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const requests: WebRoute['request'][] = [];
    await browser.route('**/*', async (route) => {
      await route.continue();
      if (!route.request.url.includes('/content?')) requests.push(route.request);
    });
    const [response] = await Promise.all([
      browser.waitForResponse(/\/fonts\?/),
      browser.goto(content(`<link rel="stylesheet" href="${PREFIX}/fonts?helvetica|arial"/>`)),
    ]);
    expect(requests.length).toBe(1);
    expect(response.status).toBe(404);
  });

  test('should not throw "Invalid Interception Id" if the request was cancelled', async ({ browser }) => {
    await browser.goto(content('<iframe></iframe>'));
    const routed = deferred();
    const release = deferred();
    await browser.route('**/*', async (route) => {
      routed.resolve();
      await release.promise;
      await route.continue();
    });
    await browser.evaluate("(url) => { document.querySelector('iframe').src = url; }", EMPTY_PAGE);
    await routed.promise;
    await browser.evaluate("() => document.querySelector('iframe').remove()");
    release.resolve();
    await browser.evaluate('() => new Promise((resolve) => setTimeout(resolve, 100))');
  });

  test('should intercept main resource during cross-process navigation', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    let intercepted = false;
    await browser.route(`${CROSS}/empty.html`, async (route) => {
      intercepted = true;
      await route.continue();
    });
    const [response] = await Promise.all([browser.waitForResponse(`${CROSS}/empty.html`), browser.goto(`${CROSS}/empty.html`)]);
    expect(response.status).toBe(200);
    expect(intercepted).toBe(true);
  });

  test('should fulfill with redirect status', async ({ browser }) => {
    await browser.goto('/title.html');
    await browser.route('**/*', async (route) => {
      if (route.request.url !== `${PREFIX}/redirect_this`) return route.continue();
      await route.fulfill({ status: 301, headers: { location: '/status?body=foo' } });
    });
    const text = await browser.evaluate('async (url) => (await fetch(url)).text()', `${PREFIX}/redirect_this`);
    expect(text).toBe('foo');
  });

  test('should support cors with GET', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars*', async (route) => {
      const headers = { 'access-control-allow-origin': route.request.url.endsWith('allow') ? '*' : 'none' };
      await route.fulfill({ contentType: 'application/json', headers, status: 200, body: JSON.stringify(['electric', 'gas']) });
    });
    const resp = await browser.evaluate("async () => (await fetch('https://example.com/cars?allow', { mode: 'cors' })).json()");
    expect(resp).toEqual(['electric', 'gas']);
    const error = await browser.evaluate("async () => (await fetch('https://example.com/cars?reject', { mode: 'cors' })).json()").catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Failed');
  });

  test('should add Access-Control-Allow-Origin by default when fulfill', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars', (route) => route.fulfill({ contentType: 'application/json', status: 200, body: JSON.stringify(['electric', 'gas']) }));
    const [result, response] = await Promise.all([
      browser.evaluate(`async () => {
        const response = await fetch('https://example.com/cars', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          mode: 'cors',
          body: JSON.stringify({ number: 1 }),
        });
        return response.json();
      }`),
      browser.waitForResponse('https://example.com/cars'),
    ]);
    expect(result).toEqual(['electric', 'gas']);
    expect(response.headers['access-control-allow-origin']).toBe(PREFIX);
  });

  test('should allow null origin for about:blank', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto('about:blank');
    await browser.route('**/something', (route) => route.fulfill({ contentType: 'text/plain', status: 200, body: 'done' }));
    const [response, text] = await Promise.all([
      browser.waitForResponse(`${CROSS}/something`),
      browser.evaluate(`async (url) => {
        const data = await fetch(url, { method: 'GET', headers: { 'X-PINGOTHER': 'pingpong' } });
        return data.text();
      }`, `${CROSS}/something`),
    ]);
    expect(text).toBe('done');
    expect(response.headers['access-control-allow-origin']).toBe('null');
  });

  test('should respect cors overrides', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/something', (route) => route.fulfill({
      contentType: 'text/plain',
      status: 200,
      headers: { 'Access-Control-Allow-Origin': 'http://non-existent' },
      body: 'done',
    }));
    const error = await browser.evaluate(`async (url) => {
      const data = await fetch(url, { method: 'GET', headers: { 'X-PINGOTHER': 'pingpong' } });
      return data.text();
    }`, `${CROSS}/something`).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Failed to fetch');
  });

  test('should not auto-intercept non-preflight OPTIONS without network interception', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const key = `options-${Date.now()}-${Math.random()}`;
    const [text1, text2] = await browser.evaluate<string[], string>(`async (url) => {
      const response1 = await fetch(url, { method: 'OPTIONS' });
      const text1 = await response1.text();
      const response2 = await fetch(url, { method: 'GET' });
      const text2 = await response2.text();
      return [text1, text2];
    }`, `${CROSS}/options?key=${key}`);
    expect(text1).toBe('Hello');
    expect(text2).toBe('World');
    expect(await browser.evaluate('(key) => fetch(`/options-log?key=${key}`).then((response) => response.json())', key)).toEqual(['OPTIONS:/options', 'OPTIONS:/options', 'GET:/options']);
  });

  test('should not auto-intercept non-preflight OPTIONS with network interception', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const key = `options-${Date.now()}-${Math.random()}`;
    await browser.route('**/options?*', (route) => route.continue());
    const [text1, text2] = await browser.evaluate<string[], string>(`async (url) => {
      const response1 = await fetch(url, { method: 'OPTIONS' });
      const text1 = await response1.text();
      const response2 = await fetch(url, { method: 'GET' });
      const text2 = await response2.text();
      return [text1, text2];
    }`, `${CROSS}/options?key=${key}`);
    expect(text1).toBe('Hello');
    expect(text2).toBe('World');
    const requests = await browser.evaluate('(key) => fetch(`/options-log?key=${key}`).then((response) => response.json())', key);
    expect(requests).toEqual(['OPTIONS:/options', 'GET:/options']);
  });

  test('should support cors with POST', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars', (route) => route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      status: 200,
      body: JSON.stringify(['electric', 'gas']),
    }));
    const resp = await browser.evaluate(`async () => {
      const response = await fetch('https://example.com/cars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ number: 1 }),
      });
      return response.json();
    }`);
    expect(resp).toEqual(['electric', 'gas']);
  });

  test('should support cors with credentials', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars', (route) => route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': PREFIX, 'Access-Control-Allow-Credentials': 'true' },
      status: 200,
      body: JSON.stringify(['electric', 'gas']),
    }));
    const resp = await browser.evaluate(`async () => {
      const response = await fetch('https://example.com/cars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ number: 1 }),
        credentials: 'include',
      });
      return response.json();
    }`);
    expect(resp).toEqual(['electric', 'gas']);
  });

  test('should not abort preflighted cross-origin redirect when a route is registered', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/never-matches', (route) => route.continue());
    const result = await browser.evaluate<string, string>(`async (url) => {
      const response = await fetch(url, { credentials: 'include', headers: { 'X-App-Version': '1.2.3' } });
      const served = await response.json();
      return response.status + ' ' + served.method + ' ' + served.headers['x-app-version'];
    }`, `${CROSS}/bounce?to=${encodeURIComponent(`${PREFIX}/cors-echo?preflight`)}`);
    expect(result).toBe('200 GET 1.2.3');
  });

  test('should reject cors with disallowed credentials', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars', (route) => route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': PREFIX },
      status: 200,
      body: JSON.stringify(['electric', 'gas']),
    }));
    const error = await browser.evaluate(`async () => {
      const response = await fetch('https://example.com/cars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ number: 1 }),
        credentials: 'include',
      });
      return response.json();
    }`).then(() => undefined, (caught: Error) => caught);
    expect(error).toBeTruthy();
  });

  test('should support cors for different methods', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/cars', (route) => route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      status: 200,
      body: JSON.stringify([route.request.method, 'electric', 'gas']),
    }));
    const post = await browser.evaluate(`async () => {
      const response = await fetch('https://example.com/cars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ number: 1 }),
      });
      return response.json();
    }`);
    expect(post).toEqual(['POST', 'electric', 'gas']);
    const remove = await browser.evaluate(`async () => {
      const response = await fetch('https://example.com/cars', { method: 'DELETE', headers: {}, mode: 'cors', body: '' });
      return response.json();
    }`);
    expect(remove).toEqual(['DELETE', 'electric', 'gas']);
  });

  test('should contain raw request header', async ({ browser }) => {
    let headers: Readonly<Record<string, string>> | undefined;
    await browser.route('**/*', async (route) => {
      headers = route.request.headers;
      await route.continue();
    });
    await browser.goto('/empty.html');
    expect(headers?.['accept']).toBeTruthy();
  });

  for (const method of ['fulfill', 'continue', 'fallback', 'abort'] as const) {
    test(`route.${method} should throw if called twice`, async ({ browser }) => {
      const handled = deferred<Error>();
      await browser.route('**/*', async (route) => {
        const decide = (): Promise<void> => (method === 'fulfill' ? route.fulfill({}) : route[method]());
        await decide();
        handled.resolve(await decide().then(() => new Error('decided twice'), (caught: Error) => caught));
      });
      const navigation = browser.goto('/empty.html').catch(() => undefined);
      const e = await handled.promise;
      expect(e.message).toContain('called twice');
      await navigation;
    });
  }

  test('should intercept when postData is more than 1MB', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const intercepted = deferred<string | undefined>();
    const POST_BODY = '0'.repeat(2 * 1024 * 1024);
    await browser.route('**/404.html', async (route) => {
      await route.abort();
      intercepted.resolve(route.request.postData);
    });
    await browser.evaluate("(body) => fetch('/404.html', { method: 'POST', body }).then(() => null, () => null)", POST_BODY);
    expect(await intercepted.promise).toBe(POST_BODY);
  });
});
