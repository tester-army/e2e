import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('control inventory', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/control-inventory');
  });

  test('check sets the checkbox and the radio without flipping a set one', async ({ screen }) => {
    const terms = screen.getByLabel('Agree to terms');
    await terms.check();
    await terms.check();
    await expect(terms).toBeChecked();
    await screen.getByRole('radio', { name: 'Medium' }).check();
    await expect(screen.getByLabel('Toggles state')).toHaveText('terms agreed, size Medium');
    await terms.uncheck();
    await expect(screen.getByLabel('Toggles state')).toHaveText('terms not agreed, size Medium');
  });

  test('a long press and a double click are told apart from a tap', async ({ screen }) => {
    const hold = screen.getByRole('button', { name: 'Hold me' });
    await hold.tap();
    await expect(screen.getByLabel('Hold state')).toHaveText('tapped');
    await hold.longPress({ duration: 700 });
    await expect(screen.getByLabel('Hold state')).toHaveText('long-pressed');
    const twice = screen.getByRole('button', { name: 'Double-click me' });
    await twice.tap();
    await expect(screen.getByLabel('Double-click state')).toHaveText('clicked once');
    await twice.doubleTap();
    await expect(screen.getByLabel('Double-click state')).toHaveText('double-clicked');
  });

  test('the file menu opens on right-click only and Rename renames the file', async ({ screen }) => {
    const row = screen.getByText('report.pdf', { exact: true });
    await row.tap();
    await expect(screen.getByLabel('File state')).toHaveText('a click selects nothing; the menu opens on right-click');
    await row.secondaryTap();
    await expect(screen.getByLabel('File state')).toHaveText('menu open for report.pdf');
    await screen.getByRole('menuitem', { name: 'Rename' }).tap();
    await expect(screen.getByLabel('File state')).toHaveText('report.pdf renamed to summary.pdf');
    await expect(screen.getByText('summary.pdf', { exact: true })).toBeVisible();
  });

  test('setInputFiles attaches files named from the project root', async ({ screen }) => {
    await screen.getByLabel('Attachments').setInputFiles(['fixtures/attachment.txt', 'fixtures/second.txt']);
    await expect(screen.getByLabel('Attachments state')).toHaveText('attachment.txt, second.txt');
  });

  test('the details view is left through the browser history', async ({ app, screen, web }) => {
    await screen.getByRole('button', { name: 'Open details' }).tap();
    await expect(web).toHaveURL('/e/control-inventory?view=details');
    await expect(screen.getByLabel('Navigation state')).toHaveText('on details');
    await app.back();
    await expect(web).toHaveURL('/e/control-inventory');
    await expect(screen.getByLabel('Navigation state')).toHaveText('back on the inventory');
  });

  test('scrollIntoView brings the footnote into view', async ({ screen }) => {
    await expect(screen.getByLabel('Footnote state')).toHaveText('out of view');
    await screen.getByText('Footnote', { exact: true }).scrollIntoView();
    await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
  });

  test('every exercise done shows the success message', async ({ app, screen }) => {
    await screen.getByLabel('Agree to terms').check();
    await screen.getByRole('radio', { name: 'Medium' }).check();
    await screen.getByRole('button', { name: 'Hold me' }).longPress({ duration: 700 });
    await screen.getByRole('button', { name: 'Double-click me' }).doubleTap();
    await screen.getByText('report.pdf', { exact: true }).secondaryTap();
    await screen.getByRole('menuitem', { name: 'Rename' }).tap();
    await screen.getByLabel('Attachments').setInputFiles('fixtures/attachment.txt');
    await screen.getByRole('button', { name: 'Open details' }).tap();
    await expect(screen.getByLabel('Navigation state')).toHaveText('on details');
    await app.back();
    await expect(screen.getByLabel('Navigation state')).toHaveText('back on the inventory');
    await screen.getByText('Footnote', { exact: true }).scrollIntoView();
    await expect(screen.getByTestId('success-message')).toHaveText('All exercises done');
  });
});
