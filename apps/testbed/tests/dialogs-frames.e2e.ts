import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { failure } from './helpers.ts';

test.describe('dialogs', { requires: ['browser'] }, () => {
  test('a throwing handler dismisses its unanswered dialog', async ({ app, browser }) => {
    await app.open('/dialogs');
    await browser.onDialog(() => { throw new Error('handler exploded'); });
    expect(await browser.evaluate('confirm("Really delete everything?")')).toBe(false);
    expect(await failure(() => browser.title())).toHaveProperty('code', 'ENGINE_FAILURE');
    expect(await browser.title()).toBe('Dialogs');
  });
});

test.describe('frames', { requires: ['browser'] }, () => {
  test('frame queries do not leak into the host page', async ({ app, screen, browser }) => {
    await app.open('/frames');
    await expect(screen.getByRole('heading', 'Frames')).toBeVisible();
    await expect(browser.frameLocator('#editor').getByRole('heading', 'Frames')).toBeHidden();
  });
});
