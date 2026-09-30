import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator } from 'e2e';
import { failure, siblingOf } from './support.ts';

/**
 * The button whose own text node reads `text`. Each button here carries an
 * aria-label that belongs to another button, and one hides a screen-reader
 * span with a decoy phrase, so neither the accessible name nor the full text
 * content names it truthfully; the rendered text does.
 */
function buttonReading(browser: Browser, text: string): Locator {
  return browser.locator(`xpath=//button[normalize-space(text())="${text}"]`);
}

test.describe('lying labels', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/lying-labels');
  });

  test('the button whose accessible name says Pay now is the wrong one', async ({ screen }) => {
    await screen.getByRole('button', 'Pay now').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('You clicked the wrong action');
  });

  test('a text match for Pay now catches the decoy phrase too', async ({ screen }) => {
    expect(await failure(() => screen.getByText(/Pay now/).tap())).toHaveProperty(
      'code',
      'LOCATOR_AMBIGUOUS',
    );
    await expect(screen.getByTestId('error-message')).toBeHidden();
  });

  test('the field whose accessible name says Amount is the wrong one', async ({ screen, browser }) => {
    await buttonReading(browser, 'Pay now').tap();
    await screen.getByLabel('Amount').fill('42.50');
    await screen.getByText('Submit payment').tap();
    await expect(screen.getByTestId('error-message')).toHaveText(
      'Type 42.50 into the field visibly labeled Amount, leave Reference empty',
    );
  });

  test('visible text drives the payment through', async ({ screen, browser }) => {
    await buttonReading(browser, 'Pay now').tap();
    await siblingOf(browser, 'Amount', 'input').fill('42.50');
    await expect(siblingOf(browser, 'Reference', 'input')).toHaveValue('');
    await screen.getByText('Submit payment').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Payment sent');
  });
});
