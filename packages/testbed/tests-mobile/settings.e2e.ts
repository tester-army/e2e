import { expect, test } from 'e2e';

/**
 * Deterministic mobile coverage against the built-in iOS Settings app.
 *
 * Settings is a real UIKit app with a navigation stack, a collection view, a
 * search field, and rows, so it exercises the projection, role normalization,
 * and actionability rules of `mobile-0.1` without shipping a fixture app.
 * Relaunching returns it to the root list, which is what gives each test a
 * known starting screen.
 */

test.describe('Settings', () => {
  test('opens on the root list', async ({ app, screen, platform }) => {
    expect(platform).toBe('ios');
    await app.open();

    // A UINavigationBar projects to the ARIA navigation role.
    await expect(screen.getByRole('navigation')).toBeVisible();
    await expect(screen.getByText('General')).toBeVisible();
    await expect(screen.getByText('Accessibility')).toBeVisible();
  });

  test('navigates into General and back', async ({ app, screen }) => {
    await app.open();

    await screen.getByText('General').tap();
    await expect(screen.getByText('About')).toBeVisible();

    await app.back();
    await expect(screen.getByText('Accessibility')).toBeVisible();
  });

  test('reads a row through the locator API', async ({ app, screen }) => {
    await app.open();

    const general = screen.getByText('General');
    expect(await general.textContent()).toBe('General');
    expect(await general.isVisible()).toBe(true);
    expect(await general.isEnabled()).toBe(true);

    const box = await general.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
  });

  test('finds a row by its accessibility role and name', async ({ app, screen }) => {
    await app.open();

    // Each row is a button nested inside its cell; the role disambiguates the
    // label that iOS repeats up the hierarchy.
    await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
    expect(await screen.getByRole('listitem').count()).toBeGreaterThan(3);
  });

  test('types into the search field', async ({ app, screen }) => {
    await app.open();

    // XCUIElementTypeSearchField projects to the searchbox role.
    const search = screen.getByRole('searchbox');
    await search.fill('accessibility');
    expect(await search.inputValue()).toContain('accessibility');
  });

  test('scrolls the root list', async ({ app, screen }) => {
    await app.open();

    await screen.swipe({ direction: 'down' });
    await expect(screen.getByRole('navigation')).toBeVisible();
  });

  test('captures a screenshot artifact', async ({ app }) => {
    await app.open();

    const relative = await app.screenshot('settings-root');
    expect(relative).toMatch(/\.png$/);
  });

  test('drives device controls', { requires: ['device'] }, async ({ app, screen, device }) => {
    await app.open();

    await device.home();
    await device.hideKeyboard();

    // Reopening after home proves the session survives leaving the app.
    await app.open();
    await expect(screen.getByText('General')).toBeVisible();
  });
});
