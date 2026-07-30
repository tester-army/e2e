import { test, expect } from 'e2e';

/**
 * Two canvas pages, both with nothing in the accessibility tree: the target on
 * /other/canvas is a `Path2D` rectangle hit-tested against raw click
 * coordinates, and /canvas draws a hamburger.
 *
 * Deterministically the only way in is arithmetic on the canvas bounding box
 * plus `web.mouse` — there is no locator for a shape. That is the honest limit
 * of the locator engine, and the reason the agentic mirror of this file uses
 * the vision tier instead.
 */
test.describe('canvas', { requires: ['web'] }, () => {
  test('clicking the drawn square raises an alert', async ({ app, web }) => {
    await app.open('/other/canvas');

    let message = '';
    const dispose = await web.onDialog(async (dialog) => {
      message = dialog.message;
      await dialog.accept();
    });
    try {
      const box = await web.locator('#myCanvas').boundingBox();
      expect(box === null).toBe(false);
      // The square is drawn at (250,150)-(350,250) in canvas space.
      await web.mouse.move((box?.x ?? 0) + 300, (box?.y ?? 0) + 200);
      await web.mouse.down();
      await web.mouse.up();
    } finally {
      await dispose();
    }
    expect(message).toBe('You clicked on the square!');
  });

  test('clicking outside the drawn square raises nothing', async ({ app, web }) => {
    await app.open('/other/canvas');

    let message = '';
    const dispose = await web.onDialog(async (dialog) => {
      message = dialog.message;
      await dialog.accept();
    });
    try {
      const box = await web.locator('#myCanvas').boundingBox();
      await web.mouse.move((box?.x ?? 0) + 30, (box?.y ?? 0) + 30);
      await web.mouse.down();
      await web.mouse.up();
    } finally {
      await dispose();
    }
    expect(message).toBe('');
  });

  test('a drawn scene is opaque to queries', async ({ app, screen, web }) => {
    await app.open('/canvas/');

    await expect(screen.getByRole('heading', { name: 'Canvas' })).toBeVisible();
    const canvas = web.locator('#burger_canvas');
    await expect(canvas).toBeVisible();
    // Everything drawn inside it — buns, patty, lettuce — has no node, no name,
    // and no role to query.
    expect(await canvas.textContent()).toBe('');
  });
});
