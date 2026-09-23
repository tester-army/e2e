import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { boxOf, centerOf, failure } from './helpers.ts';

test('screen.tapAt taps a viewport point with no node behind it', async ({ app, screen }) => {
  await app.open('/pointer');

  const box = await boxOf(screen.getByRole('image', { name: 'Pointer pad' }));
  await screen.tapAt({ x: box.x + 40, y: box.y + 30 });

  await expect(screen.getByLabel('Pad state')).toHaveText('tapped at 40,30');
});

test('locator.tap({ position }) taps at an offset of the node', async ({ app, screen }) => {
  await app.open('/pointer');
  const pad = screen.getByRole('image', { name: 'Pointer pad' });

  await pad.tap({ position: { x: 300, y: 10 } });
  await expect(screen.getByLabel('Pad state')).toHaveText('tapped at 300,10');

  await pad.click({ position: { x: 0, y: 0 } });
  await expect(screen.getByLabel('Pad state')).toHaveText('tapped at 0,0');
});

test('a position tap on a node the engine cannot bring into view fails as the engine reports', async ({ app, screen }) => {
  await app.open('/pointer');

  expect(
    await failure(() => screen.getByLabel('Hidden pad').tap({ position: { x: 1, y: 1 }, timeout: 1_000 })),
  ).toHaveProperty('code', 'ACTION_FAILED');
});

test('screen.swipe({ from, to }) moves the pointer along the path', async ({ app, screen }) => {
  await app.open('/pointer');

  const box = await boxOf(screen.getByRole('image', { name: 'Pointer pad' }));
  await screen.swipe({ from: { x: box.x + 10, y: box.y + 20 }, to: { x: box.x + 250, y: box.y + 20 } });

  await expect(screen.getByLabel('Pad state')).toHaveText('swiped from 10,20 to 250,20');
});

test('a path swipe drags and drops on the board', async ({ app, screen }) => {
  await app.open('/board');

  const card = centerOf(await boxOf(screen.getByText('Design review', { exact: true })));
  const done = centerOf(await boxOf(screen.getByLabel('Done column')));
  await screen.swipe({ from: card, to: done });

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});

test.describe('raw pointer input', { requires: ['web'] }, () => {
  test('raw mouse input drags along the pad', async ({ app, screen, web }) => {
    await app.open('/pointer');
    const box = await boxOf(screen.getByRole('image', { name: 'Pointer pad' }));

    await web.mouse.move(box.x + 10, box.y + 20);
    await web.mouse.down();
    await web.mouse.move(box.x + 150, box.y + 20);
    await web.mouse.up();
    await expect(screen.getByLabel('Pad state')).toHaveText('swiped from 10,20 to 150,20');
  });
});
