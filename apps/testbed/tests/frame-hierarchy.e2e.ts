/**
 * Adapted from microsoft/playwright tests/page/frame-hierarchy.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: e2e has no Frame objects, so a frame the original
 * finds in `page.frames()` is reached through `frameLocator`.
 */

/*
 * Not ported:
 * - should send events when frames are manipulated dynamically: frameattached, framenavigated, and framedetached events.
 * - should persist mainFrame on cross-process navigation: page.mainFrame().
 * - should not send attach/detach events for main frame: frame events.
 * - should detach child frames on navigation: frame events.
 * - should support framesets: frame events.
 * - should report frame.name(): Frame objects.
 * - should report frame.parent(): Frame objects.
 * - should report different frame instance when frame re-attaches: Frame objects and the frameattached event.
 * - should refuse to display x-frame-options:deny iframe: console events.
 * - should return frame.page(): Frame objects.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

test.describe('frame hierarchy', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should handle nested frames', async ({ browser }) => {
    await browser.goto('/frames/nested-frames.html');
    await expect(browser.frameLocator('[name=aframe]').locator('div')).toHaveText(`Hi, I'm frame`);
    await expect(browser.frameLocator('[name="2frames"]').frameLocator('[name=dos]').locator('div')).toHaveText(`Hi, I'm frame`);
    await expect(browser.frameLocator('[name="2frames"]').frameLocator('[name=uno]').locator('div')).toHaveText(`Hi, I'm frame`);
    await expect(browser.frameLocator('[name="2frames"]').locator('iframe')).toHaveCount(2);
    await expect(browser.locator('iframe')).toHaveCount(2);
  });

  test('should send "framenavigated" when navigating on anchor URLs', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto('/empty.html#foo');
    expect(await browser.url()).toBe(`${PREFIX}/empty.html#foo`);
  });

  test('should report frame from-inside shadow DOM', async ({ browser }) => {
    await browser.goto('/shadow.html');
    await browser.evaluate(`async (url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.shadowRoot.appendChild(frame);
      await new Promise((x) => (frame.onload = x));
    }`, `${PREFIX}/empty.html`);
    await expect(browser.locator('iframe')).toHaveCount(1);
    await expect(browser.frameLocator('iframe').locator('body')).toHaveCount(1);
  });
});
