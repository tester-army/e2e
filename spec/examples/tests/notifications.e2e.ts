import { test, expect } from 'e2e';

/**
 * Cross-platform strategies, side by side:
 * 1. one portable test with platform branching,
 * 2. a mobile-only test using `device` (declares `platforms`).
 */

export const mentionBadge = test('mention shows an unread badge', { session: 'member' }, async ({ app, agent, screen, platform }) => {
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

export const pushNotification = test(
  'tapping a push notification opens the task',
  { platforms: ['ios', 'android'], session: 'member' },
  async ({ device, agent }) => {
    await device.setPermission('notifications', 'allow');
    await device.home();

    await device.pushNotification({
      title: 'Ada mentioned you',
      threadId: 'task-42',
    });

    await agent.act('open the notification that just arrived');
    await agent.assert('the app opened directly on task 42 with the mention highlighted');
  },
);
