import { expect, openScenario, test } from './fixtures.ts';

// The home list is the app's first screen on every attempt; each row's test
// id is the scenario name and its label joins the name and the description.
test('home lists the scenarios and opens one', { tags: ['smoke'] }, async ({ app, device, screen }) => {
  await expect(screen.getByTestId('Login Form')).toBeVisible();
  await expect(screen.getByTestId('Modal Flow')).toBeVisible();

  await openScenario({ device, screen }, 'Login Form');
  await expect(screen.getByTestId('login-button')).toBeVisible();

  await app.back();
  await expect(screen.getByTestId('Login Form')).toBeVisible();
});
