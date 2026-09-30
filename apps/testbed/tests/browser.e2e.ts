import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('browser fixture', { requires: ['browser'], tags: ['browser'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/browser');
  });

  test('navigation verbs and the URL and title matchers', async ({ browser }) => {
    await expect(browser).toHaveTitle('Browser');

    await browser.goto('/about');
    await expect(browser).toHaveURL('/about');
    await expect(browser).toHaveTitle('About page');
    expect(await browser.url()).toMatch(/\/about$/);
    expect(await browser.title()).toBe('About page');

    await browser.back();
    await expect(browser).toHaveURL('/browser');
    await browser.forward();
    await expect(browser).toHaveURL(/about$/);
  });

  test('waitForURL waits out a delayed navigation', async ({ screen, browser }) => {
    await screen.getByRole('button', 'Go to about, soon').tap();
    await browser.waitForURL('/about');
    await expect(screen.getByRole('heading', 'About')).toBeVisible();
  });

  test('reload runs the page again', async ({ screen, browser }) => {
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 1');
    await browser.reload();
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 2');
  });

  test('the viewport size is what the page measures', async ({ screen, browser }) => {
    await browser.setViewport({ width: 500, height: 700 });
    await expect(screen.getByLabel('Viewport')).toHaveText('500x700');
    await browser.setViewport({ width: 1024, height: 640 });
    await expect(screen.getByLabel('Viewport')).toHaveText('1024x640');
  });

  test('cookies set from the test reach the page and read back', async ({ screen, browser }) => {
    await expect(screen.getByLabel('Cookies')).toHaveText('no cookies');

    await browser.setCookies([{ name: 'theme', value: 'dark', url: await browser.url() }]);
    await browser.reload();
    await expect(screen.getByLabel('Cookies')).toContainText('theme=dark');
    const theme = (await browser.cookies()).find((cookie) => cookie.name === 'theme');
    expect(theme?.value).toBe('dark');
  });
});
