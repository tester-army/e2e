/**
 * Adapted from microsoft/playwright tests/page/page-network-idle.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.setContent(html, { waitUntil })` is `browser.goto(content(html), { waitUntil })`,
 * and a request the server holds is one a route holds.
 */

/*
 * Not ported:
 * - should wait for networkidle in waitForNavigation: needs `page.waitForNavigation`.
 * - should wait for networkidle when navigating iframe: needs `frame.goto`.
 * - should wait for networkidle from the popup: needs `page.waitForEvent('popup')` and `popup.waitForLoadState`.
 */

import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

/** A promise with its resolver, for a route handler the test holds open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Playwright's `networkIdleTest`: holds `fetch-request-a.js` and `fetch-request-b.js`
 * until the test answers them, and checks `action` settles only 500ms after the last.
 */
async function networkIdleTest(browser: Browser, action: () => Promise<void>): Promise<void> {
  const held = (suffix: string) => {
    const requested = deferred();
    const answer = deferred();
    return { suffix, requested, answer };
  };
  const a = held('/fetch-request-a.js');
  const b = held('/fetch-request-b.js');
  for (const request of [a, b]) {
    await browser.route(`**${request.suffix}`, async (route) => {
      request.requested.resolve();
      await request.answer.promise;
      await route.fulfill({ status: 404, body: 'File not found' });
    });
  }

  const actionPromise = action();
  let actionFinished = false;
  void actionPromise.then(() => (actionFinished = true));

  await a.requested.promise;
  expect(actionFinished).toBe(false);

  await browser.evaluate("() => window['fetchSecond']()");
  a.answer.resolve();

  await b.requested.promise;
  expect(actionFinished).toBe(false);

  let timerTriggered = false;
  const timer = setTimeout(() => (timerTriggered = true), 500);
  b.answer.resolve();

  await actionPromise;
  clearTimeout(timer);
  expect(timerTriggered).toBe(true);
}

test.describe('page network idle', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should navigate to empty page with networkidle', async ({ browser }) => {
    const [response] = await Promise.all([
      browser.waitForResponse('**/empty.html'),
      browser.goto(EMPTY_PAGE, { waitUntil: 'networkidle' }),
    ]);
    expect(response.status).toBe(200);
  });

  test('should wait for networkidle to succeed navigation', async ({ browser }) => {
    await networkIdleTest(browser, () => browser.goto('/networkidle.html', { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle to succeed navigation with request from previous navigation', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content("<script>fetch('/never');</script>"));
    await networkIdleTest(browser, () => browser.goto('/networkidle.html', { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle in setContent', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await networkIdleTest(browser, () => browser.goto(content("<script src='networkidle.js'></script>"), { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle in setContent with request from previous navigation', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content("<script>fetch('/never');</script>"));
    await networkIdleTest(browser, () => browser.goto(content("<script src='networkidle.js'></script>"), { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle in setContent from the child frame', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await networkIdleTest(browser, () => browser.goto(content("<iframe src='networkidle.html'></iframe>"), { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle from the child frame', async ({ browser }) => {
    await networkIdleTest(browser, () => browser.goto('/networkidle-frame.html', { waitUntil: 'networkidle' }));
  });

  test('should wait for networkidle when iframe attaches and detaches', async ({ browser }) => {
    let done = false;
    const promise = browser.goto(content(`
      <body>
        <script>
          const iframe = document.createElement('iframe');
          iframe.src = ${JSON.stringify(`${PREFIX}/never`)};
          document.body.appendChild(iframe);
        </script>
      </body>
    `), { waitUntil: 'networkidle' }).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(done).toBe(false);
    await browser.evaluate("() => { document.querySelector('iframe').remove(); }");
    await promise;
    expect(done).toBe(true);
  });

  test('should work after repeated navigations in the same page', async ({ browser }) => {
    let requestCount = 0;
    await browser.route('**/empty.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `
        <script>
          fetch('http://localhost:8000/sample').then(res => console.log(res.json()))
        </script>`,
    }));
    await browser.route('**/sample', async (route) => {
      requestCount++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ content: 'sample' }) });
    });
    await browser.goto(EMPTY_PAGE, { waitUntil: 'networkidle' });
    expect(requestCount).toBe(1);
    await browser.goto(EMPTY_PAGE, { waitUntil: 'networkidle' });
    expect(requestCount).toBe(2);
  });

  test('should not wait for an open EventSource connection', async ({ browser }) => {
    const page = content("<script>new EventSource('/sse');</script>");
    const [response] = await Promise.all([
      browser.waitForResponse('**/content?**'),
      browser.goto(page, { waitUntil: 'networkidle' }),
    ]);
    expect(response.status).toBe(200);
  });

  test('should not wait for an open EventSource connection in setContent', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`<script>
      window.__sseOpened = new Promise(resolve => {
        const es = new EventSource('/sse');
        es.onmessage = () => resolve();
      });
    </script>`), { waitUntil: 'networkidle' });
    await browser.evaluate("() => window['__sseOpened'].then(() => null)");
  });
});
