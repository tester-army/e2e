import { test, expect } from 'e2e';

/**
 * Three failure surfaces: a page that is only an error illustration, a page
 * whose own images 404, and a URL that returns 404 while still rendering.
 *
 * The interesting one is the middle: four subresources fail and nothing in the
 * SDK reports it. `waitForResponse` observes one request at a time and only
 * while the test is waiting, so "this page loaded with broken resources" has to
 * be reconstructed by hand.
 */
test.describe('error pages', { requires: ['web'] }, () => {
  test('an error illustration page', async ({ app, web }) => {
    await app.open('/error_page/');
    await expect(web).toHaveTitle('Error Page');
  });

  test('a 404 URL still renders a document', async ({ app, screen, web }) => {
    // `app.open` does not surface the status code, so a hard 404 is
    // indistinguishable from a successful navigation until something is read
    // off the page.
    await app.deepLink('https://seleniumbase.io/other/');
    await expect(web).toHaveTitle('SeleniumBase Docs');
    await expect(screen.getByRole('heading', { name: '404 - Not found' })).toBeVisible();
  });

  test('broken subresources are only observable one request at a time', async ({ app, web }) => {
    // `web.route` needs a live page, so a route can never cover the *first*
    // navigation of an attempt: something has to be opened first.
    await app.open('/');

    const requested: string[] = [];
    // Routing every image is the only way to enumerate them: there is no
    // page-level response feed in the SDK, so the count is reconstructed from
    // the request side and the status has to be asserted separately.
    await web.route('**/broken_links/*', async (route) => {
      requested.push(route.request.url);
      await route.continue();
    });

    await app.deepLink('https://seleniumbase.io/other/broken_page');
    await expect(web).toHaveTitle('Error Page');

    expect(requested.length).toBe(4);
  });

  test('waitForResponse sees a single named failure', async ({ app, web }) => {
    await app.open('/');
    const [response] = await Promise.all([
      web.waitForResponse('**/broken_links/bad_image_1.png'),
      app.deepLink('https://seleniumbase.io/other/broken_page'),
    ]);
    expect(response.status).toBe(404);
  });
});
