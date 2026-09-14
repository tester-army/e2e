import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

/**
 * The seleniumbase.io/w3schools/* pages are tryit-style editors: a textarea of
 * source and an `#iframeResult` document written into an `about:blank` frame by
 * the host page. Every control under test therefore lives one document down,
 * with no origin of its own — the shape that catches frame handling that only
 * works for same-origin `src` frames.
 *
 * Writing this file surfaced the sharpest limit in the SDK: `web.frameLocator`
 * returns a `Screen`, and `Screen` exposes only the six `getBy*` queries. There
 * is no `Screen.locator`, so inside a frame there is no CSS escape hatch — a
 * control with no accessible name is not addressable at all, and a second frame
 * boundary cannot be expressed. Three tests below are `skip`ped for exactly
 * that reason rather than deleted.
 */
test.describe('frames', { requires: ['web'] }, () => {
  test('checkboxes inside a written document', async ({ app, web }) => {
    await app.open('/w3schools/checkboxes');
    const result = web.frameLocator('#iframeResult');

    await expect(result.getByRole('heading', { name: 'Show Checkboxes' })).toBeVisible();
    await result.getByLabel('I have a bike').check();
    await result.getByLabel('I have a boat').check();
    await expect(result.getByLabel('I have a bike')).toBeChecked();
    await expect(result.getByLabel('I have a car')).not.toBeChecked();

    await result.getByLabel('I have a bike').uncheck();
    await expect(result.getByLabel('I have a bike')).not.toBeChecked();
  });

  test('radio groups inside a written document', async ({ app, web }) => {
    await app.open('/w3schools/radio_buttons');
    const result = web.frameLocator('#iframeResult');

    // Two independent groups on one page: selecting a language must not
    // disturb the age group.
    await result.getByLabel('CSS').check();
    await result.getByLabel('31 - 60').check();
    await expect(result.getByLabel('CSS')).toBeChecked();
    await expect(result.getByLabel('31 - 60')).toBeChecked();

    await result.getByLabel('JavaScript').check();
    await expect(result.getByLabel('CSS')).not.toBeChecked();
    await expect(result.getByLabel('31 - 60')).toBeChecked();
  });

  test('a double click inside a frame', async ({ app, web }) => {
    await app.open('/w3schools/double_click');
    const result = web.frameLocator('#iframeResult');

    // String text matching is exact by default in this spec, unlike
    // Playwright and Testing Library: the paragraph continues past this phrase.
    await result.getByText('Double-click this paragraph', { exact: false }).doubleTap();
    await expect(result.getByText('Hello World')).toBeVisible();
  });

  test('a frame navigated to a full site', async ({ app, web }) => {
    await app.open('/w3schools/sbase');
    // The written document immediately navigates itself to seleniumbase.io, so
    // the frame ends up cross-document but same-origin.
    await expect(
      web.frameLocator('#iframeResult').getByRole('heading', { name: /SeleniumBase README/ }),
    ).toBeVisible();
  });

  test('the host page can still see the frame element itself', async ({ app, web }) => {
    await app.open('/w3schools/checkboxes');
    // `web.locator` is page-scoped, so it reaches the `<iframe>` but nothing
    // inside it: there is no frame-piercing selector.
    await expect(web.locator('#iframeResult')).toBeVisible();
    expect(await web.locator('#vehicle1').count()).toBe(0);
  });

  test('a document nested two frames deep', async ({ app, web }) => {
    await app.open('/w3schools/iframes');
    const result = web.frameLocator('#iframeResult');
    await expect(result.getByRole('heading', { name: /nested iframes/ })).toBeVisible();

    // The inner document is reachable, but not through the locator engine:
    // `Screen` has no `frameLocator`, so a second boundary cannot be expressed.
    // Dropping to `evaluate` is the whole finding — and it also means no
    // assertion, action, or auto-retry applies to anything in there.
    const innerText = await web.evaluate(() => {
      const outer = document.querySelector('#iframeResult');
      const outerDoc = outer instanceof HTMLIFrameElement ? outer.contentDocument : null;
      const inner = outerDoc?.querySelector('iframe');
      return inner?.contentDocument?.body?.textContent ?? '';
    });
    expect(innerText).toContain('This page is displayed in an iframe.');
  });

  test(
    'a file input inside a frame',
    { skip: 'no Screen.locator: the file input has no accessible name, so it is unaddressable' },
    async ({ app, web }) => {
      await app.open('/w3schools/file_upload');
      const result = web.frameLocator('#iframeResult');

      // `<input type="file" id="myFile">` — no label, no name, no test id. The
      // only query that could reach it is a CSS selector, and `Screen` has
      // none, so `setInputFiles` has no target inside a frame.
      await expect(result.getByRole('button', { name: 'Try it' })).toBeVisible();
    },
  );

  test(
    'HTML5 drag and drop inside a frame',
    { skip: 'no Screen.locator: neither the dragged image nor the drop zone has a name' },
    async ({ app, web }) => {
      await app.open('/w3schools/drag_drop');
      const result = web.frameLocator('#iframeResult');

      // `#drag1` is an `<img>` with no alt and `#div1` is an empty `<div>`:
      // `dragTo` needs two locators and neither endpoint is nameable.
      await expect(result.getByText('Drag the W3Schools image', { exact: false })).toBeVisible();
    },
  );
});
