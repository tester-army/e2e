import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('dialogs', { requires: ['web'] }, () => {
  test('accepting a confirm dialog', async ({ app, screen, web }) => {
    await app.open('/dialogs');
    const dispose = await web.onDialog('accept');
    await screen.getByRole('button', { name: 'Delete everything' }).tap();
    await expect(screen.getByRole('status', { name: 'Decision' })).toHaveText('deleted');
    await dispose();
  });

  test('dismissing a confirm dialog', async ({ app, screen, web }) => {
    await app.open('/dialogs');
    const dispose = await web.onDialog('dismiss');
    await screen.getByRole('button', { name: 'Delete everything' }).tap();
    await expect(screen.getByRole('status', { name: 'Decision' })).toHaveText('kept');
    await dispose();
  });

  test('custom dialog handlers read the message', async ({ app, screen, web }) => {
    await app.open('/dialogs');
    let message = '';
    const dispose = await web.onDialog(async (dialog) => {
      message = dialog.message;
      await dialog.accept();
    });
    await screen.getByRole('button', { name: 'Delete everything' }).tap();
    await expect(screen.getByRole('status', { name: 'Decision' })).toHaveText('deleted');
    expect(message).toBe('Really delete everything?');
    await dispose();
  });
});

test.describe('frames', { requires: ['web'] }, () => {
  test('queries and actions scoped inside an iframe', async ({ app, web }) => {
    await app.open('/frames');
    const editor = web.frameLocator('#editor');
    await editor.getByLabel('Note').fill('hello from outside');
    await editor.getByRole('button', { name: 'Save note' }).tap();
    await expect(editor.getByRole('status', { name: 'Note state' })).toHaveText(
      'saved: hello from outside',
    );
  });

  test('frame queries do not leak into the host page', async ({ app, screen, web }) => {
    await app.open('/frames');
    await expect(screen.getByRole('heading', { name: 'Frames' })).toBeVisible();
    await expect(web.frameLocator('#editor').getByRole('heading', { name: 'Frames' })).toBeHidden();
  });
});

test.describe('downloads', { requires: ['web'] }, () => {
  test('waits for a triggered download', async ({ app, screen, web }) => {
    await app.open('/downloads');
    const download = await web.waitForDownload(() =>
      screen.getByRole('link', { name: 'Download report' }).tap(),
    );
    expect(download.suggestedFilename).toBe('report.csv');
    expect(download.path).toContain('downloads/');
  });
});
