/**
 * Adapted from microsoft/playwright tests/page/locator-frame.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: the routed frame pages are pages the server serves (`content()`).
 */

/*
 * Not ported:
 * - should wait for frame: asserts Playwright's `locator('body').locator('iframe').contentFrame()` log text; e2e has no locator.frameLocator.
 * - should non work for non-frame: asserts Playwright's error text naming the matched `<div>`; e2e reports its own.
 * - locator.frameLocator should work for iframe: e2e has no locator.frameLocator.
 * - locator.frameLocator should throw on ambiguity: e2e has no locator.frameLocator.
 * - locator.frameLocator should not throw on first/last/nth: e2e frame locators have no first/last/nth.
 * - getBy coverage: e2e has no getByAltText or getByTitle; the other queries are kept as `getBy coverage (role, text, test id, label, placeholder)`.
 * - should work with COEP/COOP/CORP isolated iframe: needs an https cross origin and page.frames().
 * - locator.contentFrame should work: e2e has no locator.contentFrame.
 * - frameLocator.owner should work: e2e has no frameLocator.owner.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS } from './helpers.ts';

const nested = content('<html><button>Hello nested iframe</button></html>');

const iframe = content(`
  <html>
    <div>
      <button data-testid="buttonId">Hello iframe</button>
      <iframe src="${nested}"></iframe>
    </div>
    <span>1</span>
    <span>2</span>
    <label for=target>Name</label><input id=target type=text placeholder=Placeholder title=Title alt=Alternative>
  </html>`);

const routed = content(`<iframe src="${iframe}" name="frame1"></iframe>`);

/** Waits `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('locator frame', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should work for iframe', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button');
    await button.waitFor();
    expect(await button.textContent()).toBe('Hello iframe');
    await expect(button).toHaveText('Hello iframe');
    await button.tap();
  });

  test('should work for nested iframe', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').frameLocator('iframe').locator('button');
    await button.waitFor();
    expect(await button.textContent()).toBe('Hello nested iframe');
    await expect(button).toHaveText('Hello nested iframe');
    await button.tap();
  });

  test('should work for $ and $$', async ({ browser }) => {
    await browser.goto(routed);
    const locator = browser.frameLocator('iframe').locator('button');
    await expect(locator).toHaveText('Hello iframe');
    const spans = browser.frameLocator('iframe').locator('span');
    await expect(spans).toHaveCount(2);
  });

  test('should wait for frame 2', async ({ browser }) => {
    await browser.goto('about:blank');
    const navigated = delay(300).then(() => browser.goto(routed));
    await browser.frameLocator('iframe').locator('button').tap();
    await navigated;
  });

  test('should wait for frame to go', async ({ browser }) => {
    await browser.goto(routed);
    const removed = delay(300).then(() => browser.evaluate("() => { document.querySelector('iframe').remove(); }"));
    await expect(browser.frameLocator('iframe').locator('button')).toBeHidden();
    await removed;
  });

  test('should not wait for frame', async ({ browser }) => {
    await browser.goto('/empty.html');
    await expect(browser.frameLocator('iframe').locator('span')).toBeHidden();
  });

  test('should not wait for frame 2', async ({ browser }) => {
    await browser.goto('/empty.html');
    await expect(browser.frameLocator('iframe').locator('span')).not.toBeVisible();
  });

  test('should not wait for frame 3', async ({ browser }) => {
    await browser.goto('/empty.html');
    await expect(browser.frameLocator('iframe').locator('span')).toHaveCount(0);
  });

  test('should click in lazy iframe', async ({ browser }) => {
    const lazy = content('<html><button>Hello iframe</button></html>');
    await browser.goto('/empty.html');
    const attached = delay(500)
      .then(() => browser.evaluate("() => { document.body.appendChild(document.createElement('iframe')); }"))
      .then(() => delay(500))
      .then(() => browser.evaluate("(src) => { document.querySelector('iframe').src = src; }", lazy));
    const button = browser.frameLocator('iframe').locator('button');
    const [, text] = await Promise.all([
      button.tap(),
      button.textContent(),
      expect(button).toHaveText('Hello iframe'),
      attached,
    ]);
    expect(text).toBe('Hello iframe');
  });

  test('waitFor should survive frame reattach', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.waitFor();
    await browser.evaluate("() => { document.querySelector('iframe').remove(); }");
    await browser.evaluate("(src) => { const iframe = document.createElement('iframe'); iframe.src = src; document.body.appendChild(iframe); }", nested);
    await promise;
  });

  test('click should survive frame reattach', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.tap();
    await browser.evaluate("() => { document.querySelector('iframe').remove(); }");
    await browser.evaluate("(src) => { const iframe = document.createElement('iframe'); iframe.src = src; document.body.appendChild(iframe); }", nested);
    await promise;
  });

  test('click should survive iframe navigation', async ({ browser }) => {
    await browser.goto(routed);
    const button = browser.frameLocator('iframe').locator('button').filter({ hasText: 'Hello nested iframe' });
    const promise = button.tap();
    const navigated = browser.evaluate("(src) => { document.querySelector('iframe').src = src; }", nested);
    await promise;
    await navigated;
  });

  test('getBy coverage (role, text, test id, label, placeholder)', async ({ browser }) => {
    await browser.goto(routed);
    const button1 = browser.frameLocator('iframe').getByRole('button');
    const button2 = browser.frameLocator('iframe').getByText('Hello', { exact: false });
    const button3 = browser.frameLocator('iframe').getByTestId('buttonId');
    await expect(button1).toHaveText('Hello iframe');
    await expect(button2).toHaveText('Hello iframe');
    await expect(button3).toHaveText('Hello iframe');
    const input1 = browser.frameLocator('iframe').getByLabel('Name');
    await expect(input1).toHaveValue('');
    const input2 = browser.frameLocator('iframe').getByPlaceholder('Placeholder');
    await expect(input2).toHaveValue('');
  });

  test('wait for hidden should succeed when frame is not in dom', async ({ browser }) => {
    await browser.goto('about:blank');
    const button = browser.frameLocator('iframe1').locator('button');
    expect(await button.isHidden()).toBeTruthy();
    await button.waitFor({ state: 'hidden', timeout: 1000 });
    await button.waitFor({ state: 'detached', timeout: 1000 });
    const error = await button.waitFor({ state: 'attached', timeout: 1000 }).catch((caught: unknown) => caught);
    expect(error).toBeDefined();
  });

  test('should treat elements inside hidden iframe as hidden', async ({ browser }) => {
    await browser.goto(content(`
      <iframe name="hidden" style="visibility: hidden" srcdoc="<button>Hidden</button>"></iframe>
      <div style="visibility: hidden">
        <iframe name="hidden-parent" srcdoc="<button>Hidden parent</button>"></iframe>
        <iframe name="visible-override" style="visibility: visible" srcdoc="<button>Visible override</button>"></iframe>
      </div>
      <iframe name="outer" style="visibility: hidden" srcdoc="<iframe name='inner' srcdoc='<button>Nested</button>'></iframe>"></iframe>
    `));

    for (const button of [
      browser.frameLocator('[name=hidden]').locator('button'),
      browser.frameLocator('[name=hidden-parent]').locator('button'),
      browser.frameLocator('[name=outer]').frameLocator('[name=inner]').locator('button'),
    ]) {
      await expect(button).toBeAttached();
      expect(await button.isVisible()).toBe(false);
      expect(await button.isHidden()).toBe(true);
      await expect(button).toBeHidden();
      await expect(button).not.toBeVisible();
      await button.waitFor({ state: 'hidden' });
    }

    const button = browser.frameLocator('[name=visible-override]').locator('button');
    expect(await button.isVisible()).toBe(true);
    await expect(button).toBeVisible();
    await button.waitFor({ state: 'visible' });
  });

  test('should wait for hidden iframe to become visible', async ({ browser }) => {
    await browser.goto(content(`<iframe name="frame" style="visibility: hidden" srcdoc="<button onclick='window.__clicked = true'>Button</button>"></iframe>`));
    const button = browser.frameLocator('[name=frame]').locator('button');
    await expect(button).toBeHidden();

    const error = await button.tap({ timeout: 1000 }).catch((caught: unknown) => caught);
    expect(error).toBeDefined();
    expect(await browser.evaluate("() => document.querySelector('iframe').contentWindow.__clicked === true")).toBe(false);

    const clickPromise = button.tap();
    const visiblePromise = expect(button).toBeVisible();
    await browser.evaluate("() => { document.querySelector('iframe').style.visibility = 'visible'; }");
    await Promise.all([clickPromise, visiblePromise]);
    expect(await browser.evaluate("() => document.querySelector('iframe').contentWindow.__clicked")).toBe(true);

    await browser.evaluate("() => { document.querySelector('iframe').style.visibility = 'hidden'; }");
    await expect(button).toBeHidden();
    expect(await button.isVisible()).toBe(false);
  });

  test('should treat elements inside hidden cross-origin iframe as hidden', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`<iframe style="visibility: hidden" src="${CROSS}/frames/frame.html"></iframe>`));
    const div = browser.frameLocator('iframe').locator('div');
    await expect(div).toHaveText(`Hi, I'm frame`);
    expect(await div.isVisible()).toBe(false);
    await expect(div).toBeHidden();

    await browser.evaluate("() => { document.querySelector('iframe').style.visibility = 'visible'; }");
    await expect(div).toBeVisible();
    expect(await div.isVisible()).toBe(true);
  });
});
