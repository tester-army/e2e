import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Web } from '@e2edev/web';
import type { Screen } from 'e2e';

const CODE = 'SHADOW-42';

/**
 * Where the closed root paints its two controls, measured from the top of the
 * light-DOM host: a 13 px hint line, then the input and the button, 12 px apart.
 */
const INPUT_CENTER_Y = 47;
const BUTTON_CENTER_Y = 100;

/** The pixel geometry of the closed form, read off the host that hosts it. */
async function shadowForm(screen: Screen, web: Web) {
  const box = await web.locator('main > div > p + div').boundingBox();
  if (box === null) throw new Error('the shadow host has no box');
  const x = box.x + box.width / 2;
  return {
    input: () => screen.tapAt({ x, y: box.y + INPUT_CENTER_Y }),
    submit: () => screen.tapAt({ x, y: box.y + BUTTON_CENTER_Y }),
  };
}

test.describe('shadow DOM form', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/shadow-dom-form');
    await expect(
      screen.getByText(
        `The form below lives inside a closed shadow root. Enter ${CODE} and press Submit.`,
      ),
    ).toBeVisible();
  });

  test(
    'fills the access code through locators',
    {
      skip: 'the input and the Submit button sit in a closed shadow root: getByPlaceholder and getByRole are LOCATOR_NOT_FOUND there, though the observation lists both nodes',
    },
    async ({ screen }) => {
      await screen.getByPlaceholder('Access code').fill(CODE);
      await screen.getByRole('button', { name: 'Submit' }).tap();
      await expect(screen.getByTestId('success-message')).toHaveText('Access granted');
    },
  );

  test('fills the access code by pixel position, wrong code first', async ({ screen, web }) => {
    const form = await shadowForm(screen, web);

    await form.input();
    await web.keyboard.type('nope');
    await form.submit();
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong access code');

    await form.input();
    for (let i = 0; i < 'nope'.length; i += 1) {
      await web.keyboard.press('Backspace');
    }
    await web.keyboard.type(CODE);
    await form.submit();
    await expect(screen.getByTestId('success-message')).toHaveText('Access granted');
    await expect(screen.getByTestId('error-message')).toBeHidden();
  });
});
