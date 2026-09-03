import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

/**
 * seleniumbase.io/other/drag_and_drop is native HTML5 drag-and-drop: the image
 * moves only if a real `dragstart`/`dragover`/`drop` sequence carries a
 * `dataTransfer` payload, which rules out synthesizing the gesture from raw
 * pointer events.
 *
 * The move is observable only as a DOM re-parent, so `evaluate` is the reader
 * here — the SDK has no structural assertion for "x is now inside y".
 */
test.describe('drag and drop', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/other/drag_and_drop');
  });

  test('drops the logo into the empty rectangle', async ({ web }) => {
    const parent = () =>
      web.evaluate(() => document.querySelector('#drag1')?.parentElement?.id ?? '');

    expect(await parent()).toBe('div2');
    await web.locator('#drag1').dragTo(web.locator('#div1'));
    expect(await parent()).toBe('div1');
  });

  test('dropping onto the original container is a no-op', async ({ web }) => {
    const parent = () =>
      web.evaluate(() => document.querySelector('#drag1')?.parentElement?.id ?? '');

    await web.locator('#drag1').dragTo(web.locator('#div2'));
    expect(await parent()).toBe('div2');
  });

  test('the draggable image is a first-class element', async ({ web }) => {
    const logo = web.locator('#drag1');
    // `draggable` is not an exposed attribute, so the read returns null even
    // though the markup sets it — the same conflation as `readonly`.
    expect(await logo.getAttribute('draggable')).toBeNull();
    expect(await logo.getAttribute('id')).toBe('drag1');
    const box = await logo.boundingBox();
    expect(box === null).toBe(false);
    expect(box?.width ?? 0).toBeGreaterThan(100);
  });
});
