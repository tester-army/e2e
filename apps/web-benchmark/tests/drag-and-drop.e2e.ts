import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('drag and drop', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/drag-and-drop');
  });

  test('an out-of-order item resets the dropzone', async ({ screen }) => {
    const dropzone = screen.getByTestId('dropzone');
    await screen.getByTestId('drag-banana').dragTo(dropzone);
    await expect(dropzone).toContainText('Banana');
    await screen.getByTestId('drag-apple').dragTo(dropzone);
    await expect(screen.getByTestId('error-message')).toHaveText('Wrong item order, starting over');
    await expect(dropzone).toHaveText('Drop items here');
  });

  test('dropping Banana then Cherry passes', async ({ screen }) => {
    const dropzone = screen.getByTestId('dropzone');
    await screen.getByTestId('drag-banana').dragTo(dropzone);
    await expect(dropzone).toContainText('Banana');
    await screen.getByTestId('drag-cherry').dragTo(dropzone);
    await expect(screen.getByTestId('success-message')).toHaveText(
      'Items dropped in the right order',
    );
  });
});
