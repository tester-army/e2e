/**
 * A long pixels-only flow of a different shape: eight drawn screens, each
 * naming one of four drawn shapes and offering a drawn Next. The shapes rotate
 * between screens, so the model has to read every new screen from its
 * screenshot rather than replay positions; the DOM shows the picks at the end.
 */

import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('act walks an eight-screen wizard painted on a canvas', async ({ web, agent, screen }) => {
  await web.goto('/canvas-wizard');
  await agent.act('complete all eight steps of the drawn wizard: on each screen tap the shape its instruction names, then tap Next');
  await expect(screen.getByRole('status')).toHaveText('wizard done: ok,ok,ok,ok,ok,ok,ok,ok');
});
