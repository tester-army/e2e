import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('browser fixture', { requires: ['web'], tags: ['browser'] }, () => {
  test('navigation verbs and the URL and title matchers', async ({ app, web }) => {
    await app.open('/browser');
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

  test('waitForURL waits out a delayed navigation', async ({ app, screen, web }) => {
    await app.open('/browser');
    await screen.getByRole('button', { name: 'Go to about, soon' }).tap();
    await web.waitForURL('/about');
    await expect(screen.getByRole('heading', { name: 'About' })).toBeVisible();
  });

  test('reload runs the page again', async ({ app, screen, web }) => {
    await app.open('/browser');
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 1');
    await web.reload();
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 2');
  });

  test('the viewport size is what the page measures', async ({ app, screen, web }) => {
    await app.open('/browser');
    await web.setViewport({ width: 500, height: 700 });
    await expect(screen.getByLabel('Viewport')).toHaveText('500x700');
    await web.setViewport({ width: 1024, height: 640 });
    await expect(screen.getByLabel('Viewport')).toHaveText('1024x640');
  });

  test('cookies set from the test reach the page and read back', async ({ app, screen, web }) => {
    await app.open('/browser');
    await expect(screen.getByLabel('Cookies')).toHaveText('no cookies');

    await web.setCookies([{ name: 'theme', value: 'dark', url: await web.url() }]);
    await web.reload();
    await expect(screen.getByLabel('Cookies')).toContainText('theme=dark');
    const theme = (await web.cookies()).find((cookie) => cookie.name === 'theme');
    expect(theme?.value).toBe('dark');
  });

  test('raw mouse input drags along the pad', async ({ app, screen, web }) => {
    await app.open('/pointer');
    const box = await screen.getByRole('image', { name: 'Pointer pad' }).boundingBox();
    if (box === null) throw new Error('pad has no box');

    await web.mouse.move(box.x + 10, box.y + 20);
    await web.mouse.down();
    await web.mouse.move(box.x + 150, box.y + 20);
    await web.mouse.up();
    await expect(screen.getByLabel('Pad state')).toHaveText('swiped from 10,20 to 150,20');
  });
});
