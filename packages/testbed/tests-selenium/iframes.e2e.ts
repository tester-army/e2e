import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

/**
 * The seleniumbase.io/w3schools/* pages are tryit-style editors: a textarea of
 * source and an `#iframeResult` document written into an `about:blank` frame by
 * the host page. Every control under test therefore lives one document down,
 * with no origin of its own — the shape that catches frame handling that only
 * works for same-origin `src` frames.
 *
 * `web.frameLocator` returns a frame scope that keeps `locator` and
 * `frameLocator`, so a control with no accessible name and a second frame
 * boundary are both reachable through the locator engine. The last three
 * tests exercise exactly that.
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

    // The inner document sits one more boundary down; the frame scope steps
    // into it, so assertions and auto-retry apply inside the nested frame too.
    await expect(
      result.frameLocator('iframe').getByText('This page is displayed in an iframe', { exact: false }),
    ).toBeVisible();
  });

  test('a file input inside a frame', async ({ app, web }) => {
    await app.open('/w3schools/file_upload');
    const result = web.frameLocator('#iframeResult');

    // `<input type="file" id="myFile">` has no label, no name, and no test id:
    // only a CSS selector reaches it, and the frame scope carries one.
    await result.locator('#myFile').setInputFiles('fixtures/attachment.txt');
    await expect(result.locator('#myFile')).toHaveValue(/attachment\.txt$/);
  });

  test('HTML5 drag and drop inside a frame', async ({ app, web }) => {
    await app.open('/w3schools/drag_drop');
    const result = web.frameLocator('#iframeResult');

    // `#drag1` is an `<img>` with no alt and `#div1` is an empty `<div>`:
    // `dragTo` needs two locators and neither endpoint is nameable.
    await result.locator('#drag1').dragTo(result.locator('#div1'));
    await expect(result.locator('#div1 img')).toBeVisible();
  });
});
