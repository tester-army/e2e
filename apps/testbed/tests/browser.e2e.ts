import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('browser fixture', { requires: ['web'], tags: ['browser'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/browser');
  });

  test('navigation verbs and the URL and title matchers', async ({ web }) => {
    await expect(web).toHaveTitle('Browser');

    await web.goto('/about');
    await expect(web).toHaveURL('/about');
    await expect(web).toHaveTitle('About page');
    expect(await web.url()).toMatch(/\/about$/);
    expect(await web.title()).toBe('About page');

    await web.back();
    await expect(web).toHaveURL('/browser');
    await web.forward();
    await expect(web).toHaveURL(/about$/);
  });

  test('waitForURL waits out a delayed navigation', async ({ screen, web }) => {
    await screen.getByRole('button', { name: 'Go to about, soon' }).tap();
    await web.waitForURL('/about');
    await expect(screen.getByRole('heading', { name: 'About' })).toBeVisible();
  });

  test('reload runs the page again', async ({ screen, web }) => {
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 1');
    await web.reload();
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 2');
  });

  test('the viewport size is what the page measures', async ({ screen, web }) => {
    await web.setViewport({ width: 500, height: 700 });
    await expect(screen.getByLabel('Viewport')).toHaveText('500x700');
    await web.setViewport({ width: 1024, height: 640 });
    await expect(screen.getByLabel('Viewport')).toHaveText('1024x640');
  });

  test('cookies set from the test reach the page and read back', async ({ screen, web }) => {
    await expect(screen.getByLabel('Cookies')).toHaveText('no cookies');

    await web.setCookies([{ name: 'theme', value: 'dark', url: await web.url() }]);
    await web.reload();
    await expect(screen.getByLabel('Cookies')).toContainText('theme=dark');
    const theme = (await web.cookies()).find((cookie) => cookie.name === 'theme');
    expect(theme?.value).toBe('dark');
  });
});
