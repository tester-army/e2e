import { test, expect } from 'e2e';

/**
 * Web-only powers via the `web` fixture — network stubbing, URL assertions,
 * dialogs. Using `web` is what constrains this test to `platforms: ['web']`.
 */
test.describe('feature flags', { platforms: ['web'], session: 'admin', tags: ['flags'] }, () => {
  test('beta board renders behind the flag', async ({ web, screen, agent }) => {
    await web.route('**/api/flags', route =>
      route.fulfill({ json: { betaBoard: true } }),
    );

    await web.goto('/boards/rocketry');

    await expect(screen.getByRole('tab', { name: 'Beta board' })).toBeVisible();
    await screen.getByRole('tab', { name: 'Beta board' }).tap();
    await web.waitForURL(/beta/);

    await agent.assert('the beta board renders without layout glitches');
  });

  test('leaving with unsaved changes warns via native dialog', async ({ web, screen }) => {
    await web.goto('/boards/rocketry/settings');
    await screen.getByLabel('Board name').fill('Rocketry v2');

    web.onDialog('dismiss');                     // stay on the page
    await web.back();

    await expect(web).toHaveURL(/settings/);
    await expect(screen.getByLabel('Board name')).toHaveValue('Rocketry v2');
  });
});
