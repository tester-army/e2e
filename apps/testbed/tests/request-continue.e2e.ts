/**
 * Adapted from microsoft/playwright tests/page/page-request-continue.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: what the server received is what `/cors-echo` answers with.
 */

/*
 * Not ported:
 * - should amend binary post data: `route.continue` takes a string `postData`.
 * - should work with Cross-Origin-Opener-Policy: needs `page.on('request' | 'response' | 'requestfinished' | 'requestfailed')`.
 * - redirected requests should report overridden headers: needs `route.fallback({ headers })` and `response.request()`.
 * - postData should return empty string when overriding body with empty string: needs `page.waitForRequest`.
 */

import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

type Served = { method: string; headers: Record<string, string | undefined>; body: string; url: string };

/** A promise with its resolver, for a route handler the test holds open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The request the server received for the page now open, which `/cors-echo` printed as its text. */
async function served(browser: Browser): Promise<Served> {
  return JSON.parse(await browser.evaluate<string>('document.body.textContent')) as Served;
}

/** The request the server received for a page `fetch` to `url` with `init`, which `/cors-echo` answered with. */
async function fetched(browser: Browser, url: string, init = '{}'): Promise<Served> {
  return JSON.parse(await browser.evaluate<string, string>(`(url) => fetch(url, ${init}).then((response) => response.text())`, url)) as Served;
}

test.describe('page request continue', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue());
    await browser.goto(EMPTY_PAGE);
  });

  test('should amend HTTP headers', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue({ headers: { ...route.request.headers, FOO: 'bar' } }));
    await browser.goto(EMPTY_PAGE);
    const request = await fetched(browser, '/cors-echo');
    expect(request.headers['foo']).toBe('bar');
  });

  test('should not allow to override unsafe HTTP headers', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue({ headers: { ...route.request.headers, host: 'bar', trailer: 'baz' } }));
    await browser.goto('/cors-echo');
    const serverRequest = await served(browser);
    expect(serverRequest.headers['trailer']).toBe(undefined);
    expect(serverRequest.headers['host']).toBe(new URL(EMPTY_PAGE).host);
  });

  test('should delete header with undefined value', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.route(`${PREFIX}/cors-echo`, (route) => route.continue({
      headers: { ...route.request.headers, foo: undefined },
    }));
    const serverRequest = await fetched(browser, `${PREFIX}/cors-echo`, "{ headers: { foo: 'a', bar: 'b' } }");
    expect(serverRequest.method).toBe('GET');
    expect(serverRequest.headers['foo']).toBeFalsy();
    expect(serverRequest.headers['bar']).toBe('b');
  });

  test('should amend method', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/*', (route) => route.continue({ method: 'POST' }));
    const request = await fetched(browser, '/cors-echo');
    expect(request.method).toBe('POST');
  });

  test('should override request url', async ({ browser }) => {
    await browser.route('**/foo', (route) => route.continue({ url: `${PREFIX}/global-var.html` }));
    const [response] = await Promise.all([browser.waitForResponse(/\/(foo|global-var\.html)$/), browser.goto(`${PREFIX}/foo`)]);
    expect(response.url).toBe(`${PREFIX}/global-var.html`);
    expect(await browser.evaluate("() => window['globalVar']")).toBe(123);
  });

  test('should not allow changing protocol when overriding url', async ({ browser }) => {
    const failed = deferred<Error | null>();
    await browser.route('**/*', async (route) => {
      try {
        await route.continue({ url: 'file:///tmp/foo' });
        failed.resolve(null);
      } catch (caught) {
        failed.resolve(caught as Error);
        await route.abort();
      }
    });
    const navigation = browser.goto(EMPTY_PAGE).catch(() => undefined);
    const error = await failed.promise;
    expect(error).toBeTruthy();
    expect(error!.message).toMatch(/scheme/);
    await navigation;
  });

  test('should not throw if request was cancelled by the page', async ({ browser }) => {
    const routed = deferred();
    const release = deferred();
    await browser.route('**/data.json', async (route) => {
      routed.resolve();
      await release.promise;
      await route.continue();
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

  test('should override method along with url', async ({ browser }) => {
    await browser.route('**/foo', (route) => route.continue({ url: `${PREFIX}/cors-echo`, method: 'POST' }));
    await browser.goto(`${PREFIX}/foo`);
    expect((await served(browser)).method).toBe('POST');
  });

  test('should amend method on main request', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue({ method: 'POST' }));
    await browser.goto('/cors-echo');
    expect((await served(browser)).method).toBe('POST');
  });

  test.describe('post data', () => {
    test('should amend post data', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      await browser.route('**/*', (route) => route.continue({ postData: 'doggo' }));
      const serverRequest = await fetched(browser, '/cors-echo', "{ method: 'POST', body: 'birdy' }");
      expect(serverRequest.body).toBe('doggo');
    });

    test('should compute content-length from post data', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      const data = 'a'.repeat(7500);
      await browser.route('**/*', (route) => route.continue({ postData: data, headers: { ...route.request.headers, 'content-type': 'application/json' } }));
      const serverRequest = await fetched(browser, '/cors-echo', "{ method: 'PATCH', body: 'birdy' }");
      expect(serverRequest.body).toBe(data);
      expect(serverRequest.headers['content-length']).toBe(String(data.length));
      expect(serverRequest.headers['content-type']).toBe('application/json');
    });

    test('should amend method and post data', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      await browser.route('**/*', (route) => route.continue({ method: 'POST', postData: 'doggo' }));
      const serverRequest = await fetched(browser, '/cors-echo', "{ method: 'GET' }");
      expect(serverRequest.method).toBe('POST');
      expect(serverRequest.body).toBe('doggo');
    });

    test('should amend utf8 post data', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      await browser.route('**/*', (route) => route.continue({ postData: 'пушкин' }));
      const serverRequest = await fetched(browser, '/cors-echo', "{ method: 'POST', body: 'birdy' }");
      expect(serverRequest.method).toBe('POST');
      expect(serverRequest.body).toBe('пушкин');
    });

    test('should amend longer post data', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      await browser.route('**/*', (route) => route.continue({ postData: 'doggo-is-longer-than-birdy' }));
      const serverRequest = await fetched(browser, '/cors-echo', "{ method: 'POST', body: 'birdy' }");
      expect(serverRequest.method).toBe('POST');
      expect(serverRequest.body).toBe('doggo-is-longer-than-birdy');
    });

    test('should use content-type from original request', async ({ browser }) => {
      await browser.goto(EMPTY_PAGE);
      await browser.route(`${PREFIX}/cors-echo`, (route) => route.continue({ postData: '{"b":2}' }));
      const request = await fetched(browser, `${PREFIX}/cors-echo`, `{ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }`);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.body).toBe('{"b":2}');
    });
  });

  test('should not delete the origin header', async ({ browser }) => {
    await browser.goto('/empty.html');
    let interceptedOrigin: string | undefined;
    await browser.route(`${CROSS}/cors-echo`, async (route) => {
      const headers = { ...route.request.headers };
      interceptedOrigin = headers['origin'];
      delete headers['origin'];
      await route.continue({ headers });
    });
    const serverRequest = await fetched(browser, `${CROSS}/cors-echo`);
    expect(serverRequest.method).toBe('GET');
    expect(interceptedOrigin).toEqual(PREFIX);
    expect(serverRequest.headers['origin']).toBe(PREFIX);
  });

  test('should continue preload link requests', async ({ browser }) => {
    let intercepted = false;
    await browser.route('**/one-style.css', async (route) => {
      intercepted = true;
      await route.continue({ headers: { ...route.request.headers, custom: 'value' } });
    });
    await browser.goto('/preload.html');
    await browser.evaluate('() => new Promise((resolve) => { const check = () => window.preloadedStyles ? resolve(true) : setTimeout(check, 20); check(); })');
    expect(intercepted).toBe(true);
    // preload.html sets the flag before switching the link to a stylesheet, which applies a task later.
    await expect.poll(() => browser.evaluate('() => window.getComputedStyle(document.body).backgroundColor')).toBe('rgb(255, 192, 203)');
  });

  test('should respect set-cookie in redirect response', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/bounce?**', (route) => route.continue({ headers: { ...route.request.headers } }));
    await browser.goto(`/bounce?cookie=${encodeURIComponent('foo=bar;  max-age=36000')}&to=/cors-echo`);
    expect((await served(browser)).headers['cookie']).toBe('foo=bar');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=bar');
  });

  test('continue should not propagate cookie override to redirects', async ({ browser }) => {
    await browser.goto('/set-cookie?cookie=foo=bar;');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=bar');
    await browser.route('**/redirect?**', (route) => route.continue({ headers: { ...route.request.headers, cookie: 'override' } }));
    await browser.goto(`/redirect?to=${encodeURIComponent(`${PREFIX}/cors-echo`)}`);
    expect((await served(browser)).headers['cookie']).toBe('foo=bar');
  });

  test('continue should not override cookie', async ({ browser }) => {
    await browser.goto('/set-cookie?cookie=foo=bar;');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=bar');
    await browser.route('**', (route) => route.continue({ headers: { ...route.request.headers, cookie: 'override', custom: 'value' } }));
    await browser.goto('/cors-echo');
    const serverRequest = await served(browser);
    expect(serverRequest.headers['cookie']).toBe('foo=bar');
    expect(serverRequest.headers['custom']).toBe('value');
  });

  test('continue with headers should send fresh cookie from the browser cookie store', async ({ browser }) => {
    await browser.goto('/set-cookie?cookie=foo=v1;');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=v1');
    await browser.route('**/cors-echo', async (route) => {
      await browser.setCookies([{ name: 'foo', value: 'v2', url: PREFIX }]);
      await route.continue({ headers: route.request.headers });
    });
    await browser.goto('/cors-echo');
    expect((await served(browser)).headers['cookie']).toBe('foo=v2');
  });

  test('continue with headers should send fresh cookie after a redirect', async ({ browser }) => {
    await browser.goto('/set-cookie?cookie=foo=v1;');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=v1');
    await browser.route('**/bounce?**', (route) => route.continue({ headers: route.request.headers }));
    await browser.goto(`/bounce?cookie=${encodeURIComponent('foo=v2;')}&to=${encodeURIComponent(`${PREFIX}/cors-echo`)}`);
    expect((await served(browser)).headers['cookie']).toBe('foo=v2');
  });

  test('redirect after continue should be able to delete cookie', async ({ browser }) => {
    await browser.goto('/set-cookie?cookie=foo=bar;');
    expect(await browser.evaluate('() => document.cookie')).toBe('foo=bar');
    await browser.route('**/redirect?**', (route) => route.continue({ headers: { ...route.request.headers } }));
    await browser.goto(`/redirect?to=${encodeURIComponent(`/set-cookie?cookie=${encodeURIComponent('foo=bar; expires=Thu, 01 Jan 1970 00:00:00 GMT')}`)}`);
    await browser.goto('/cors-echo');
    expect((await served(browser)).headers['cookie']).toBeFalsy();
  });

  test('continue should propagate headers to redirects', async ({ browser }) => {
    await browser.route('**/redirect?**', (route) => route.continue({ headers: { ...route.request.headers, custom: 'value' } }));
    await browser.goto('/redirect?to=/cors-echo');
    expect((await served(browser)).headers['custom']).toBe('value');
  });

  test('continue should drop content-length on redirects', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.route('**/redirect?**', (route) => route.continue({ headers: { ...route.request.headers, custom: 'value' } }));
    const serverRequest = await fetched(browser, `${PREFIX}/redirect?to=/cors-echo`, "{ method: 'POST', body: 'foo' }");
    expect(serverRequest.method).toBe('GET');
    expect(serverRequest.headers['content-length']).toBeUndefined();
    expect(serverRequest.headers['content-type']).toBeUndefined();
    expect(serverRequest.headers['custom']).toBe('value');
  });

  test('continue should delete headers on redirects', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.route('**/redirect?**', (route) => route.continue({
      headers: { ...route.request.headers, foo: undefined },
    }));
    const serverRequest = await fetched(browser, `${PREFIX}/redirect?to=/cors-echo`, "{ headers: { foo: 'a' } }");
    expect(serverRequest.method).toBe('GET');
    expect(serverRequest.headers['foo']).toBeFalsy();
  });

  test('propagate headers same origin redirect', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate("() => { document.cookie = 'a=b'; }");
    const serverRequest = await fetched(
      browser,
      `${PREFIX}/redirect?to=${encodeURIComponent('/cors-echo?preflight')}`,
      "{ headers: { authorization: 'credentials', custom: 'foo' }, credentials: 'include' }",
    );
    expect(serverRequest.headers['authorization']).toBe('credentials');
    expect(serverRequest.headers['cookie']).toBe('a=b');
    expect(serverRequest.headers['custom']).toBe('foo');
  });

  test('propagate headers cross origin', async ({ browser }) => {
    await browser.goto('/empty.html');
    const serverRequest = await fetched(
      browser,
      `${CROSS}/cors-echo?preflight`,
      "{ headers: { authorization: 'credentials', custom: 'foo' }, credentials: 'include' }",
    );
    expect(serverRequest.headers['authorization']).toBe('credentials');
    expect(serverRequest.headers['custom']).toBe('foo');
  });

  test('propagate headers cross origin redirect', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate("() => { document.cookie = 'a=b'; }");
    const serverRequest = await fetched(
      browser,
      `${PREFIX}/bounce?status=301&to=${encodeURIComponent(`${CROSS}/cors-echo?preflight`)}`,
      "{ headers: { authorization: 'credentials', custom: 'foo' }, credentials: 'include' }",
    );
    expect(serverRequest.headers['authorization']).toBeFalsy();
    expect(serverRequest.headers['cookie']).toBeFalsy();
    expect(serverRequest.headers['custom']).toBe('foo');
  });

  test('propagate headers cross origin redirect after interception', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate("() => { document.cookie = 'a=b'; }");
    await browser.route('**/bounce?**', (route) => route.continue({ headers: { ...route.request.headers, authorization: 'credentials', custom: 'foo' } }));
    const serverRequest = await fetched(
      browser,
      `${PREFIX}/bounce?status=301&to=${encodeURIComponent(`${CROSS}/cors-echo?preflight`)}`,
      "{ headers: { authorization: 'none' }, credentials: 'include' }",
    );
    expect(serverRequest.headers['authorization']).toBe('credentials');
    expect(serverRequest.headers['cookie']).toBeFalsy();
    expect(serverRequest.headers['custom']).toBe('foo');
  });

  test('continue should pass on 307 cross-origin redirect', async ({ browser }) => {
    const final = `${PREFIX}${content('<!doctype html><title>final</title><p>ok</p>')}`;
    await browser.goto('/empty.html');
    await browser.goto(content(`
      <form id="f" method="POST" action="${CROSS}/bounce?status=307&to=${encodeURIComponent(final)}">
        <input type="submit">
      </form>`));
    await browser.route('**/*', (route) => route.continue());
    await Promise.all([
      browser.waitForURL(final),
      browser.locator('input').tap(),
    ]);
    await expect(browser.locator('p')).toHaveText('ok');
  });

  test('should intercept css variable with background url', async ({ browser }) => {
    const intercepted = deferred();
    let interceptedRequests = 0;
    await browser.route(`${PREFIX}/pptr.png`, async (route) => {
      ++interceptedRequests;
      intercepted.resolve();
      await route.continue();
    });
    await browser.goto(content(`
    <style>
      @keyframes JNDzq {
        0% { background-position: 0 0 }
        to { background-position: 100 0 }
      }
      div {
        --background: url(/pptr.png);
        background-image: var(--background);
        animation: JNDzq 1s linear infinite;
      }
    </style>
    <div>Yo!</div>`));
    expect(await browser.locator('div').textContent()).toBe('Yo!');
    await intercepted.promise;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(interceptedRequests).toBe(1);
  });

  test('continue should not change multipart/form-data body', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const sendFormData = async (): Promise<string> => {
      const [status, body] = await browser.evaluate<[number, string]>(`async () => {
        const newFile = new File(['file content'], 'file.txt');
        const formData = new FormData();
        formData.append('file', newFile);
        const response = await fetch('/cors-echo', { method: 'POST', credentials: 'include', body: formData });
        return [response.status, (await response.json()).body];
      }`);
      expect(status).toBe(200);
      return body;
    };
    const reqBefore = await sendFormData();
    await browser.route('**/*', (route) => route.continue());
    const reqAfter = await sendFormData();
    const fileContent = [
      'Content-Disposition: form-data; name="file"; filename="file.txt"',
      'Content-Type: application/octet-stream',
      '',
      'file content',
      '------'].join('\r\n');
    expect(reqBefore).toContain(fileContent);
    expect(reqAfter).toContain(fileContent);
  });

  test('should not forward Host header on cross-origin redirect', async ({ browser }) => {
    await browser.route('**/*', async (route) => {
      const headers = route.request.headers;
      expect(headers).not.toHaveProperty('host');
      await route.continue({ headers });
    });
    const [response] = await Promise.all([
      browser.waitForResponse('**/cors-echo'),
      browser.goto(`${PREFIX}/bounce?to=${encodeURIComponent(`${CROSS}/cors-echo`)}`),
    ]);
    expect(response.status).toBe(200);
    expect((await served(browser)).headers['host']).toBe(new URL(CROSS).host);
  });
});
