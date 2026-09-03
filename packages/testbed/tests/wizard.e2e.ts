import { test, expect } from '@e2edev/e2e';

test.describe('workspace wizard', { serial: true, tags: ['wizard'] }, () => {
  let chosenPlan = '';

  test('step 1: name the workspace', async ({ app, screen }) => {
    await app.open('/wizard');
    await screen.getByLabel('Workspace name').fill('Rocketry');
    await screen.getByRole('button', { name: 'Next' }).tap();
    await expect(screen.getByRole('heading', { name: 'Step 2: Plan' })).toBeVisible();
  });

  test('step 2: pick a plan', async ({ screen }) => {
    await screen.getByLabel('Plan').selectOption('Pro');
    chosenPlan = 'Pro';
    await screen.getByRole('button', { name: 'Next' }).tap();
    await expect(screen.getByRole('heading', { name: 'Step 3: Confirm' })).toBeVisible();
  });

  test('step 3: confirm with state from earlier members', async ({ screen }) => {
    await screen.getByRole('button', { name: 'Create workspace' }).tap();
    await expect(screen.getByRole('status', { name: 'Summary' })).toHaveText(
      `Created "Rocketry" on the ${chosenPlan} plan`,
    );
  });
});
