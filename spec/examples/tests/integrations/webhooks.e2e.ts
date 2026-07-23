import { test, expect, webhook } from 'e2e';

/**
 * World-state assertions: the app's outbound webhooks are captured and
 * asserted with eventually-consistent resource matchers — no polling code.
 */
export default test('completing a task fires the outbound webhook', { tags: ['integrations'], session: 'admin' }, async ({ app, agent }) => {
  const hook = webhook.capture('task-events');

  await app.open('/settings/integrations');
  await agent.act('add an outgoing webhook for task events pointing at this URL', {
    url: hook.url,
  });

  await app.open('/boards/rocketry');
  await agent.act('mark the task "Design the launch page" as done');

  const delivery = await hook.waitFor({ body: { type: 'task.completed' } });

  await expect(hook).toHaveReceived({
    payload: { task: { title: /launch page/i, status: 'done' } },
  });

  // delivery payload is plain data — assert with normal expect too
  await expect((delivery.body as { actor: string }).actor).toBe('admin@orbit.test');
});
