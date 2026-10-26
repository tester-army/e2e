import { expect } from 'e2e';
import { taskTest as test } from './fixtures.ts';

test('completes a task', { session: 'admin' }, async ({ screen, task }) => {
  await screen.getByRole('checkbox', task).check();
  await expect(screen.getByRole('checkbox', task)).toBeChecked();
});
