import { test, expect } from 'e2e';

/** The center of a box, the point a finger would aim for. */
function centerOf(box: { x: number; y: number; width: number; height: number } | null): { x: number; y: number } {
  if (box === null) throw new Error('node has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('screen.tapAt taps a viewport point with no node behind it', async ({ app, screen }) => {
  await app.open('/pointer');

  const box = await screen.getByRole('image', { name: 'Pointer pad' }).boundingBox();
  if (box === null) throw new Error('pad has no box');
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

  const failure: unknown = await screen
    .getByLabel('Hidden pad')
    .tap({ position: { x: 1, y: 1 }, timeout: 1_000 })
    .then(() => undefined, (error: unknown) => error);

  expect((failure as { code?: string } | undefined)?.code).toBe('ACTION_FAILED');
});

test('screen.swipe({ from, to }) moves the pointer along the path', async ({ app, screen }) => {
  await app.open('/pointer');

  const box = await screen.getByRole('image', { name: 'Pointer pad' }).boundingBox();
  if (box === null) throw new Error('pad has no box');
  await screen.swipe({ from: { x: box.x + 10, y: box.y + 20 }, to: { x: box.x + 250, y: box.y + 20 } });

  await expect(screen.getByLabel('Pad state')).toHaveText('swiped from 10,20 to 250,20');
});

test('a path swipe drags and drops on the board', async ({ app, screen }) => {
  await app.open('/board');

  const card = centerOf(await screen.getByText('Design review', { exact: true }).boundingBox());
  const done = centerOf(await screen.getByLabel('Done column').boundingBox());
  await screen.swipe({ from: card, to: done });

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});
