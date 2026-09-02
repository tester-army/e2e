/**
 * Portable agentic flows: the same test runs on the iOS simulator and the
 * Android emulator because nothing here names a platform label. The
 * instruction describes the goal, the judgment reads the screen, and the
 * `device` fixture arranges state the same way on both. Every act step stays
 * inside the grammar, so a passing run records a trace the next run replays.
 */

import { z } from 'zod';
import { expect, test } from './fixtures.ts';

test('reads the operating system version under a dark, offline arrangement', async ({ agent, device }) => {
  await device.setAppearance('dark');
  await device.setNetwork('offline');
  await device.setLocation({ latitude: 37.3349, longitude: -122.009 });

  await agent.act(
    'open the screen that describes this device: on iOS it is General then About, on Android it is About phone near the bottom of the list',
  );
  await agent.assert('the screen shows the operating system version of this device');
  const { version } = await agent.extract('the operating system version shown on this screen, as displayed', {
    schema: z.object({ version: z.string() }),
  });
  expect(version).toMatch(/\d/);

  await device.setNetwork('online');
});

test('drills into Accessibility and comes back to the Settings home', async ({ agent, app, device }) => {
  await device.setAppearance('light');

  await agent.act('open the Accessibility settings');
  await agent.assert('an Accessibility settings screen is shown');
  await app.back();
  await agent.assert('the Settings home screen is shown, with Accessibility listed among the rows');
});
