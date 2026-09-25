import { test } from '@e2edev/web';
import { expect } from 'e2e';

const TARGET = 'Launch Approval Draft';

test.describe('playbook cleanup', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/playbook-cleanup');
    await expect(screen.getByRole('heading', { level: 3 })).toHaveText([
      'NDA Review',
      TARGET,
      'Vendor Onboarding',
    ]);
  });

  test('deleting the draft removes it from an exact-name search', async ({ screen }) => {
    const more = screen.getByRole('button', { name: `More actions for ${TARGET}` });
    await more.tap();
    await expect(more).toBeExpanded();
    await screen
      .getByRole('menu', { name: `Actions for ${TARGET}` })
      .getByRole('menuitem', { name: 'Delete' })
      .tap();

    const dialog = screen.getByRole('dialog', { name: 'Remove Playbook' });
    await expect(dialog).toContainText(`Are you sure you want to remove "${TARGET}"?`);
    await dialog.getByRole('button', { name: 'Remove' }).tap();
    await expect(dialog).toBeHidden();
    await expect(screen.getByRole('heading', { level: 3 })).toHaveText(['NDA Review', 'Vendor Onboarding']);

    await screen.getByLabel('Search playbooks').fill(TARGET);
    await expect(screen.getByTestId('success-message')).toHaveText(`No playbooks match "${TARGET}".`);
  });

  test('cancelling the dialog keeps the draft searchable', async ({ screen }) => {
    await screen.getByRole('button', { name: `More actions for ${TARGET}` }).tap();
    await screen.getByRole('menuitem', { name: 'Delete' }).tap();
    const dialog = screen.getByRole('dialog', { name: 'Remove Playbook' });
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(dialog).toBeHidden();

    await screen.getByLabel('Search playbooks').fill(TARGET);
    await expect(screen.getByRole('heading', { level: 3 })).toHaveText([TARGET]);
    await expect(screen.getByTestId('success-message')).toBeHidden();
  });
});
