import { expect, taskTest as test } from './fixtures.ts';

test('completes a task', { session: 'admin' }, async ({ app, screen, project, task }) => {
  await app.open(`/projects/${project.id}`);
  await screen.getByRole('checkbox', task.title).check();
  await expect(screen.getByRole('checkbox', task.title)).toBeChecked();
});
