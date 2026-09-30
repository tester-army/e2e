import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('context menu trap', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/context-menu-trap');
  });

  test('right-click opens nothing; the row menu renames the file', async ({ screen }) => {
    // The page advertises right-click but has no contextmenu handler.
    await screen.getByText('report.pdf').secondaryTap();
    await expect(screen.getByRole('button', 'Rename')).toHaveCount(0);

    await screen.getByRole('button', 'More actions for report.pdf').tap();
    await screen.getByRole('button', 'Rename').tap();
    const name = screen.getByLabel('New file name');
    await expect(name).toHaveValue('report.pdf');
    await name.fill('summary.pdf');
    await screen.getByRole('button', 'Save').tap();

    await expect(screen.getByTestId('success-message')).toHaveText('File renamed to summary.pdf');
    await expect(screen.getByText('summary.pdf')).toBeVisible();
    await expect(screen.getByText('report.pdf')).toHaveCount(0);
    await expect(screen.getByText('quarterly-report.pdf')).toBeVisible();
  });

  test('the decoy menu items refuse and keep the file', async ({ screen }) => {
    const more = screen.getByRole('button', 'More actions for report.pdf');
    await more.tap();
    await screen.getByRole('button', 'Duplicate').tap();
    await expect(screen.getByTestId('notice-message')).toHaveText(
      'Duplicating is disabled for sample files',
    );

    await more.tap();
    await screen.getByRole('button', 'Delete').tap();
    await expect(screen.getByTestId('notice-message')).toHaveText('Sample files cannot be deleted');
    await expect(screen.getByText('report.pdf')).toBeVisible();
    await expect(screen.getByTestId('success-message')).toHaveCount(0);
  });
});
