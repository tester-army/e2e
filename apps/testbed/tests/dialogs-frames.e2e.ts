import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('dialogs', { requires: ['browser'] }, () => {
  test('accepting a confirm dialog', async ({ app, screen, browser }) => {
    await app.open('/dialogs');
    const dispose = await browser.onDialog('accept');
    await screen.getByRole('button', 'Delete everything').tap();
    await expect(screen.getByRole('status', 'Decision')).toHaveText('deleted');
    await dispose();
  });

  test('dismissing a confirm dialog', async ({ app, screen, browser }) => {
    await app.open('/dialogs');
    const dispose = await browser.onDialog('dismiss');
    await screen.getByRole('button', 'Delete everything').tap();
    await expect(screen.getByRole('status', 'Decision')).toHaveText('kept');
    await dispose();
  });

  test('custom dialog handlers read the message', async ({ app, screen, browser }) => {
    await app.open('/dialogs');
    let message = '';
    const dispose = await browser.onDialog(async (dialog) => {
      message = dialog.message;
      await dialog.accept();
    });
    await screen.getByRole('button', 'Delete everything').tap();
    await expect(screen.getByRole('status', 'Decision')).toHaveText('deleted');
    expect(message).toBe('Really delete everything?');
    await dispose();
  });
});

test.describe('frames', { requires: ['browser'] }, () => {
  test('queries and actions scoped inside an iframe', async ({ app, browser }) => {
    await app.open('/frames');
    const editor = browser.frameLocator('#editor');
    await editor.getByLabel('Note').fill('hello from outside');
    await editor.getByRole('button', 'Save note').tap();
    await expect(editor.getByRole('status', 'Note state')).toHaveText(
      'saved: hello from outside',
    );
  });

  test('frame queries do not leak into the host page', async ({ app, screen, browser }) => {
    await app.open('/frames');
    await expect(screen.getByRole('heading', 'Frames')).toBeVisible();
    await expect(browser.frameLocator('#editor').getByRole('heading', 'Frames')).toBeHidden();
  });
});

test.describe('downloads', { requires: ['browser'] }, () => {
  test('waits for a triggered download', async ({ app, screen, browser }) => {
    await app.open('/downloads');
    const download = await browser.waitForDownload(() =>
      screen.getByRole('link', 'Download report').tap(),
    );
    expect(download.suggestedFilename).toBe('report.csv');
    expect(download.path).toContain('downloads/');
  });
});
