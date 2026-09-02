/**
 * Device suite: the agent-device backend drives the iOS Settings app, with
 * deterministic device management through the contributed `device` fixture.
 * Device-global arrangements (network, appearance, location) run before the
 * agent; each is recorded as a `device.<method>` step, no model involved.
 */

import { test } from './fixtures.ts';

test('reads the software version under a dark, offline arrangement', async ({ agent, device }) => {
  // Deterministic backend-defined actions: no model, recorded as device.* steps.
  await device.setAppearance('dark');
  await device.setNetwork('offline');
  await device.setLocation({ latitude: 37.3349, longitude: -122.009 });

  await agent.act('open the Settings app, go to General, then open About');
  await agent.assert('the About screen shows an iOS Version row with a version value');

  // Restore connectivity deterministically once the flow is done.
  await device.setNetwork('online');
});

test('navigates to Calendar under a light arrangement', async ({ agent, device }) => {
  await device.setAppearance('light');

  await agent.act('open the Settings app, navigate to Apps, then Calendar, without using search');
  await agent.assert('a Calendar settings screen is visible');
});
