import { expect, openScenario, test } from './fixtures.ts';

// The home list is the app's first screen; each row's test id is the scenario
// name and its label joins the name and the description.
test('home lists the scenarios and opens one', { tags: ['smoke'] }, async ({ app, device, screen }) => {
  await app.open();
  await expect(screen.getByTestId('Login Form')).toBeVisible();
  await expect(screen.getByTestId('Modal Flow')).toBeVisible();

  await openScenario({ app, device, screen }, 'Login Form');
  await expect(screen.getByTestId('login-button')).toBeVisible();

  await app.back();
  await expect(screen.getByTestId('Login Form')).toBeVisible();
});
