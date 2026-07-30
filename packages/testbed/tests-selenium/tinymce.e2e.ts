import { test, expect } from 'e2e';

/**
 * seleniumbase.io/tinymce swaps a `<textarea>` for the TinyMCE editor: a
 * toolbar in the host document driving a `contenteditable` body inside a
 * generated iframe whose id (`#mce_0_ifr`) only exists after initialization.
 *
 * The editor body is the worst case for a frame-scoped `Screen`: it is a
 * `<body>`, so it has no accessible name and no queryable role, and `Screen`
 * has no CSS escape hatch. Everything below therefore has to be addressed
 * through the *content* of the editor — the text that happens to be in it —
 * which is why one test reads the markup through `evaluate`.
 */
test.describe('tinymce', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/tinymce/');
  });

  test('initializes and exposes its toolbar', async ({ screen, web }) => {
    await expect(screen.getByRole('heading', { name: 'TinyMCE WYSIWYG Editor' })).toBeVisible();
    // The assertion waits out initialization: the frame does not exist until
    // TinyMCE replaces the textarea.
    await expect(
      web.frameLocator('#mce_0_ifr').getByText('Welcome to the TinyMCE demo!'),
    ).toBeVisible();
    await expect(screen.getByRole('button', { name: /^Bold/ })).toBeVisible();
  });

  test('types into the editable body', async ({ web }) => {
    const heading = web.frameLocator('#mce_0_ifr').getByText('Welcome to the TinyMCE demo!');
    // Tapping the existing content is the only way to put the caret in the
    // editor: the body itself is not addressable from a frame-scoped Screen.
    await heading.tap();
    await web.keyboard.type('e2e was here. ');

    await expect(
      web.frameLocator('#mce_0_ifr').getByText('e2e was here.', { exact: false }),
    ).toBeVisible();
  });

  test('a toolbar button formats the next typed text', async ({ screen, web }) => {
    await web.frameLocator('#mce_0_ifr').getByText('Welcome to the TinyMCE demo!').tap();
    await screen.getByRole('button', { name: /^Bold/ }).tap();
    await web.keyboard.type('emphatic');

    await expect(
      web.frameLocator('#mce_0_ifr').getByText('emphatic', { exact: false }),
    ).toBeVisible();
    // Whether it is *bold* is a markup question, and the only reader for markup
    // inside a frame is `evaluate`.
    const bold = await web.evaluate(() => {
      const frame = document.querySelector('#mce_0_ifr');
      const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      return doc?.querySelector('strong')?.textContent ?? '';
    });
    expect(bold).toContain('emphatic');
  });

  test('fill reports success on a rich-text host and changes nothing', async ({ web }) => {
    const frame = web.frameLocator('#mce_0_ifr');
    const heading = frame.getByText('Welcome to the TinyMCE demo!');
    await expect(heading).toBeVisible();

    // The editor content is `contenteditable`, so `fill` is actionable and
    // resolves without error — but TinyMCE reverts the mutation, so the text is
    // untouched. A silent no-op is the worst failure mode an action can have:
    // nothing in the step record distinguishes it from a real edit, which is
    // why rich text has to be driven by keyboard input instead.
    await heading.fill('replaced by e2e');

    await expect(heading).toBeVisible();
    expect(await frame.getByText('replaced by e2e', { exact: false }).count()).toBe(0);
  });
});
