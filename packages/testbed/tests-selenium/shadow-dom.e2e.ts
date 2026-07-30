import { test, expect } from 'e2e';

/**
 * seleniumbase.io/other/shadow_dom is a `<fancy-tabs>` custom element: the tab
 * strip and the panel container live inside an open shadow root, while the tab
 * buttons and panels themselves are slotted light DOM the component decorates
 * with ARIA at connect time.
 *
 * That split is the point. Queries have to pierce the shadow boundary to reach
 * `#panels`, and the roles the test relies on do not exist in the markup at
 * all — they are assigned by script after the element upgrades.
 */
test.describe('shadow dom', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/other/shadow_dom');
  });

  test('the component upgrades and exposes tab semantics', async ({ screen }) => {
    await expect(screen.getByRole('heading', { name: /Shadow DOM/ })).toBeVisible();
    await expect(screen.getByRole('tab', { name: 'Tab 1' })).toBeVisible();
    await expect(screen.getByRole('tab', { name: 'Tab 1' })).toBeSelected();
    await expect(screen.getByRole('tab', { name: 'Tab 2' })).not.toBeSelected();
  });

  test('selecting a tab swaps the visible panel', async ({ screen }) => {
    await expect(screen.getByText('Content Panel 1')).toBeVisible();
    await expect(screen.getByText('Content Panel 2')).toBeHidden();

    await screen.getByRole('tab', { name: 'Tab 2' }).tap();

    await expect(screen.getByRole('tab', { name: 'Tab 2' })).toBeSelected();
    await expect(screen.getByText('Content Panel 2')).toBeVisible();
    await expect(screen.getByText('Content Panel 1')).toBeHidden();
  });

  test('arrow keys move the selection', async ({ screen, web }) => {
    await screen.getByRole('tab', { name: 'Tab 1' }).tap();
    await web.keyboard.press('ArrowRight');
    await expect(screen.getByText('Content Panel 2')).toBeVisible();
    await web.keyboard.press('ArrowRight');
    await expect(screen.getByText('Content Panel 3')).toBeVisible();
    await web.keyboard.press('ArrowLeft');
    await expect(screen.getByText('Content Panel 2')).toBeVisible();
  });

  test('a web selector reaches an element inside the shadow root', async ({ web }) => {
    // `#panels` exists only in the shadow tree; nothing in the document markup
    // carries that id.
    await expect(web.locator('#panels')).toBeVisible();
    const strip = web.locator('#tabs');
    expect(await strip.count()).toBe(1);
  });
});
