import { test, expect, files } from 'e2e';

/**
 * Files are a resource: the agent can only use files explicitly given to a
 * step (host-side narrowing), and `context` tells it what each file is.
 */
export default test('attach a spec document to a task', { session: 'member' }, async ({ app, agent, screen }) => {
  const specDoc = files.from('fixtures/launch-spec.pdf', {
    context: 'Product spec for the launch page, PDF, 4 pages',
  });

  await app.open('/boards/rocketry');
  await screen.getByText('Design the launch page').tap();

  await agent.act('attach the spec document to this task', {
    files: [specDoc],
  });

  await expect(screen.getByRole('link', { name: /launch-spec\.pdf/i })).toBeVisible();
  await agent.assert('the attachment shows a PDF preview thumbnail');
});
