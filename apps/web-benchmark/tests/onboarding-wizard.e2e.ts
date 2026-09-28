import { test } from '@e2e-dev/web';
import type { Web } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';
import { siblingOf } from './support.ts';

/** Taps a bare-div button by its visible text `times` times. */
async function tapTimes(target: Locator, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await target.tap();
  }
}

/** Fills the Account step from the brief and moves on to Address. */
async function completeAccount(screen: Screen, web: Web): Promise<void> {
  await siblingOf(web, 'Full name', 'input').fill('Maria Novak');
  await siblingOf(web, 'Email', 'input').fill('maria.novak@example.com');
  await siblingOf(web, 'Phone', 'input').fill('+48 601 222 333');
  await screen.getByText('Next').tap();
  await expect(screen.getByText('Step 2 of 5')).toBeVisible();
}

/** Fills the Address step, picks the country from its bare-div dropdown, and moves on to Profile. */
async function completeAddress(screen: Screen, web: Web): Promise<void> {
  await siblingOf(web, 'Street', 'input').fill('Krucza 12');
  await siblingOf(web, 'City', 'input').fill('Warsaw');
  await siblingOf(web, 'Postal code', 'input').fill('00-585');
  const country = siblingOf(web, 'Country', 'div');
  await country.tap();
  await screen.getByText('Poland').tap();
  await expect(country).toHaveText('Poland');
  await screen.getByText('Next').tap();
  await expect(screen.getByText('Step 3 of 5')).toBeVisible();
}

/**
 * Steers the calendar from June 2026 to March 14, 1990, picks the occupation,
 * counts the stepper to 7, and moves on to Preferences.
 */
async function completeProfile(screen: Screen, web: Web): Promise<void> {
  await expect(screen.getByText('June 2026')).toBeVisible();
  await tapTimes(screen.getByText('«'), 3);
  await tapTimes(screen.getByText('‹'), 6);
  await tapTimes(screen.getByText('‹ month'), 3);
  await expect(screen.getByText('March 1990')).toBeVisible();
  await screen.getByText('14').tap();
  await expect(screen.getByText('Selected: March 14, 1990')).toBeVisible();
  const occupation = siblingOf(web, 'Occupation', 'div');
  await occupation.tap();
  await screen.getByText('Product designer').tap();
  await expect(occupation).toHaveText('Product designer');
  const stepper = siblingOf(web, 'Years of experience', 'div');
  await tapTimes(stepper.getByText('+'), 7);
  await expect(stepper.getByText('7')).toBeVisible();
  await screen.getByText('Next').tap();
  await expect(screen.getByText('Step 4 of 5')).toBeVisible();
}

/** Flips the toggles the brief names, leaves the trap off, picks the plan, and moves on to Review. */
async function completePreferences(screen: Screen, web: Web): Promise<void> {
  await siblingOf(web, 'Product updates', 'div').tap();
  await siblingOf(web, 'SMS alerts', 'div').tap();
  await siblingOf(web, 'Weekly digest', 'div').tap();
  await expect(siblingOf(web, 'Product updates', 'div')).toHaveText('On');
  await expect(siblingOf(web, 'SMS alerts', 'div')).toHaveText('Off');
  await expect(siblingOf(web, 'Weekly digest', 'div')).toHaveText('On');
  await expect(siblingOf(web, 'Beta features', 'div')).toHaveText('Off');
  await screen.getByText('Studio').tap();
  await screen.getByText('Next').tap();
  await expect(screen.getByText('Step 5 of 5')).toBeVisible();
}

test.describe('onboarding wizard', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/onboarding-wizard');
    await expect(screen.getByText('Step 1 of 5')).toBeVisible();
  });

  test('back keeps what was typed and the brief comes back with it', async ({ screen, web }) => {
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Full name does not match the brief')).toBeVisible();

    await completeAccount(screen, web);
    await expect(screen.getByText('Support PIN: 8412')).toBeHidden();

    await screen.getByText('Back').tap();
    await expect(screen.getByText('Step 1 of 5')).toBeVisible();
    await expect(screen.getByText('Support PIN: 8412')).toBeVisible();
    await expect(siblingOf(web, 'Full name', 'input')).toHaveValue('Maria Novak');
    await expect(siblingOf(web, 'Phone', 'input')).toHaveValue('+48 601 222 333');
  });

  test('the address step takes the brief through its bare-div dropdown', async ({ screen, web }) => {
    await completeAccount(screen, web);
    await completeAddress(screen, web);
  });

  test('the profile step steers the calendar three decades back', async ({ screen, web }) => {
    await completeAccount(screen, web);
    await completeAddress(screen, web);
    await completeProfile(screen, web);
  });

  test('the preferences step flips the toggles the brief names and leaves the trap off', async ({
    screen,
    web,
  }) => {
    await completeAccount(screen, web);
    await completeAddress(screen, web);
    await completeProfile(screen, web);
    await completePreferences(screen, web);
  });

  test('the review step repeats the brief and finishes with the PIN', async ({ screen, web }) => {
    await completeAccount(screen, web);
    await completeAddress(screen, web);
    await completeProfile(screen, web);
    await completePreferences(screen, web);

    await expect(screen.getByText('Maria Novak · maria.novak@example.com · +48 601 222 333')).toBeVisible();
    await expect(screen.getByText('Krucza 12, 00-585 Warsaw, Poland')).toBeVisible();
    await expect(screen.getByText('Born March 14, 1990 · Product designer · 7 years')).toBeVisible();
    await expect(screen.getByText('Plan: Studio')).toBeVisible();
    await siblingOf(web, 'Support PIN from the brief', 'input').fill('8412');
    await siblingOf(web, 'I confirm the details are correct', 'div').tap();
    await screen.getByText('Finish').tap();

    await expect(screen.getByText('Onboarding complete')).toBeVisible();
    await expect(screen.getByText('Welcome aboard, Maria Novak')).toBeVisible();
  });
});
