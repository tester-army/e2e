import { test, expect } from '@e2edev/e2e';

/**
 * Cross-platform strategies, side by side:
 * 1. one portable test with platform branching,
 * 2. a mobile-only test on a backend target, driven entirely through `agent`.
 */

test('mention shows an unread badge', { session: 'member' }, async ({ app, agent, screen, platform }) => {
  await app.open('/boards/rocketry');

  if (platform === 'web') {
    await agent.act('open notification preferences from the sidebar');
  } else {
    await agent.act('open notification preferences from the profile tab');
  }

  await screen.getByRole('switch', { name: 'Mentions' }).check();
  await app.back();

  await agent.act('mention yourself in a comment on any task');
  await expect(screen.getByRole('status', { name: 'Unread notifications' })).toBeVisible();
});

test(
  'tapping a push notification opens the task',
  { platforms: ['ios', 'android'] },
  async ({ agent }) => {
    // On a backend target every device affordance is an agent tool declared
    // by the integration (push injection, permissions, home).
    await agent.act('allow notifications, go to the home screen, and inject a push titled "Ada mentioned you" for thread task-42');
    await agent.act('open the notification that just arrived');
    await agent.assert('the app opened directly on task 42 with the mention highlighted');
  },
);
