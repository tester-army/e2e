/**
 * Device suite: the agent-device executor drives the iOS Settings app on a
 * local simulator. Flows are planned by the model, so runs are structurally
 * comparable, not identical; assertions also route through the executor.
 */

import { test } from 'e2e';

test('finds the software version in General > About', async ({ agent }) => {
  await agent.act('open the Settings app, go to General, then open About');
  await agent.assert('the About screen shows an iOS Version row with a version value');
});

test('turns on Week Numbers in Calendar settings', async ({ agent }) => {
  // Direct navigation, not the Settings search overlay: search steals focus
  // into a transient scene whose accessibility tree the runner cannot read.
  // Week Numbers, unlike notification rows, exists on a pristine simulator
  // where no app has ever registered for notifications.
  await agent.act('open the Settings app, navigate to Apps, then Calendar, without using search, and make sure the Week Numbers switch is on');
  await agent.assert('the Week Numbers switch in Calendar settings is on');
});
