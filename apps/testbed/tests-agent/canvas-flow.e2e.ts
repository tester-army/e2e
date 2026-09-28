/**
 * A long pixels-only flow: ten digits and a confirm on a keypad that exists
 * only as canvas pixels, feedback included. Nothing in the tree names a key or
 * shows what was entered, so every action has to be placed and verified from
 * the screenshot; the DOM learns the result only when the drawn OK is pressed.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('act enters a ten-digit code on a keypad painted on a canvas', async ({ web, agent, screen }) => {
  await web.goto('/canvas-flow');
  await agent.act('on the drawn keypad enter the code 3141592653 digit by digit, check the display shows it, then press OK');
  await expect(screen.getByRole('status')).toHaveText('code accepted: 3141592653');
});
