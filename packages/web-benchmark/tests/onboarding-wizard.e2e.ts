import { test } from '@e2edev/web';
import type { Web } from '@e2edev/web';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';

/**
 * The bare-div control that follows a visible label. The wizard wires no
 * labels, roles, placeholders, or ids, so document order beside the label
 * text is the only handle on a dropdown, stepper, or toggle.
 */
function beside(web: Web, label: string): Locator {
  return web.locator(`xpath=//div[normalize-space(text())="${label}"]/following-sibling::div[1]`);
}

/** The unlabeled text input at `index` on the current step, zero-based. */
function textbox(screen: Screen, index: number): Locator {
  return screen.getByRole('textbox').nth(index);
}

/** Taps a bare-div button by its visible text `times` times. */
async function tapTimes(target: Locator, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await target.tap();
  }
}

/** Fills the three account fields of step 1 from the brief. */
async function fillAccount(screen: Screen): Promise<void> {
  await textbox(screen, 0).fill('Maria Novak');
  await textbox(screen, 1).fill('maria.novak@example.com');
  await textbox(screen, 2).fill('+48 601 222 333');
}

test.describe('onboarding wizard', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/onboarding-wizard');
    await expect(screen.getByText('Step 1 of 5')).toBeVisible();
  });

  test('back keeps what was typed and the brief comes back with it', async ({ screen }) => {
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Full name does not match the brief')).toBeVisible();

    await fillAccount(screen);
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Step 2 of 5')).toBeVisible();
    await expect(screen.getByText('Support PIN: 8412')).toBeHidden();

    await screen.getByText('Back').tap();
    await expect(screen.getByText('Step 1 of 5')).toBeVisible();
    await expect(screen.getByText('Support PIN: 8412')).toBeVisible();
    await expect(textbox(screen, 0)).toHaveValue('Maria Novak');
    await expect(textbox(screen, 2)).toHaveValue('+48 601 222 333');
  });

  test('every step filled from the brief completes onboarding', async ({ screen, web }) => {
    await fillAccount(screen);
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Step 2 of 5')).toBeVisible();

    await textbox(screen, 0).fill('Krucza 12');
    await textbox(screen, 1).fill('Warsaw');
    await textbox(screen, 2).fill('00-585');
    await beside(web, 'Country').tap();
    await screen.getByText('Poland').tap();
    await expect(beside(web, 'Country')).toHaveText('Poland');
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Step 3 of 5')).toBeVisible();

    await expect(screen.getByText('June 2026')).toBeVisible();
    await tapTimes(screen.getByText('«'), 3);
    await tapTimes(screen.getByText('‹'), 6);
    await tapTimes(screen.getByText('‹ month'), 3);
    await expect(screen.getByText('March 1990')).toBeVisible();
    await screen.getByText('14').tap();
    await expect(screen.getByText('Selected: March 14, 1990')).toBeVisible();
    await beside(web, 'Occupation').tap();
    await screen.getByText('Product designer').tap();
    await expect(beside(web, 'Occupation')).toHaveText('Product designer');
    const stepper = beside(web, 'Years of experience');
    await tapTimes(stepper.getByText('+'), 7);
    await expect(stepper.getByText('7')).toBeVisible();
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Step 4 of 5')).toBeVisible();

    await beside(web, 'Product updates').tap();
    await beside(web, 'SMS alerts').tap();
    await beside(web, 'Weekly digest').tap();
    await expect(beside(web, 'Product updates')).toHaveText('On');
    await expect(beside(web, 'SMS alerts')).toHaveText('Off');
    await expect(beside(web, 'Weekly digest')).toHaveText('On');
    await expect(beside(web, 'Beta features')).toHaveText('Off');
    await screen.getByText('Studio').tap();
    await screen.getByText('Next').tap();
    await expect(screen.getByText('Step 5 of 5')).toBeVisible();

    await expect(screen.getByText('Maria Novak · maria.novak@example.com · +48 601 222 333')).toBeVisible();
    await expect(screen.getByText('Krucza 12, 00-585 Warsaw, Poland')).toBeVisible();
    await expect(screen.getByText('Born March 14, 1990 · Product designer · 7 years')).toBeVisible();
    await expect(screen.getByText('Plan: Studio')).toBeVisible();
    await screen.getByRole('textbox').fill('8412');
    await beside(web, 'I confirm the details are correct').tap();
    await screen.getByText('Finish').tap();

    await expect(screen.getByText('Onboarding complete')).toBeVisible();
    await expect(screen.getByText('Welcome aboard, Maria Novak')).toBeVisible();
  });
});
