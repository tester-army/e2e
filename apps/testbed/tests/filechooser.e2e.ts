/**
 * Adapted from microsoft/playwright tests/page/page-filechooser.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a file chooser is answered by `setInputFiles` on the control whose
 * click opens it, so the page's own `click()` on the input is a button that does it.
 */

/*
 * Not ported:
 * - should emit event once: needs `page.once('filechooser')`.
 * - should emit event via prepend: needs `page.prependListener('filechooser')`.
 * - should emit event for iframe: needs `filechooser` events.
 * - should emit event on/off: needs `page.on('filechooser')` and `page.off`.
 * - should emit event addListener/removeListener: needs `page.addListener('filechooser')`.
 * - should work when file input is attached to DOM: needs `page.waitForEvent('filechooser')`.
 * - should not throw when filechooser belongs to iframe: needs `filechooser` events and `frame.setContent`.
 * - should not throw when frame is detached immediately: needs `page.on('filechooser')` and `frame.setContent`.
 * - should respect timeout: needs `page.waitForEvent('filechooser')`.
 * - should respect default timeout when there is no custom timeout: needs `page.setDefaultTimeout`.
 * - should prioritize exact timeout over default timeout: needs `page.setDefaultTimeout`.
 * - should work with no timeout: needs `page.waitForEvent('filechooser', { timeout: 0 })`.
 * - should abort with signal: needs `page.waitForEvent('filechooser', { signal })`.
 * - should return the same file chooser when there are many watchdogs simultaneously: needs `FileChooser` objects.
 * - should not trim big uploaded files: no file chooser; ported in page-set-input-files.e2e.ts.
 * - should work for single file pick: needs `fileChooser.isMultiple()`.
 * - should work for "multiple": needs `fileChooser.isMultiple()`.
 * - should work for "webkitdirectory": needs `fileChooser.isMultiple()`.
 * - should trigger listener added before navigation: needs `page.once('filechooser')`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asset, content, CROSS, PREFIX } from './helpers.ts';

/** A button whose click clicks the page's file input, as `picker.click()` does in Playwright's tests. */
const PICKER = "<input type=file><button onclick=\"document.querySelector('input').click()\">pick</button>";

/** Resolves, in the page, with the first picked file's text once the input fires `input`. */
const readPicked = `() => {
  const picker = document.querySelector('input');
  window.picked = new Promise((x) => { picker.oninput = x; }).then(() => {
    const reader = new FileReader();
    const promise = new Promise((fulfill) => { reader.onload = fulfill; });
    reader.readAsText(picker.files[0]);
    return promise.then(() => reader.result);
  });
}`;

test.describe('page filechooser', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should upload multiple large files', async ({ browser }) => {
    const filesCount = 10;
    await browser.goto('/input/fileupload-multi.html');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-chooser-'));
    try {
      const uploadFile = path.join(dir, '50MB_1.zip');
      const str = 'A'.repeat(1024);
      const stream = fs.createWriteStream(uploadFile);
      for (let i = 0; i < 49 * 1024; i++) {
        await new Promise<void>((fulfill, reject) => stream.write(str, (error) => (error ? reject(error) : fulfill())));
      }
      await new Promise((fulfill) => stream.end(fulfill));
      const uploadFiles = [uploadFile];
      for (let i = 2; i <= filesCount; i++) {
        const dstFile = path.join(dir, `50MB_${i}.zip`);
        fs.copyFileSync(uploadFile, dstFile);
        uploadFiles.push(dstFile);
      }
      await browser.evaluate("() => { const button = document.createElement('button'); button.textContent = 'pick'; button.type = 'button'; button.onclick = () => document.querySelector('input[type=\"file\"]').click(); document.body.append(button); }");
      await browser.locator('button').setInputFiles(uploadFiles);
      const filesLen = await browser.evaluate('document.getElementsByTagName("input")[0].files.length');
      expect(filesLen).toEqual(filesCount);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('should work when file input is not attached to DOM', async ({ browser }) => {
    await browser.goto(content(`<button onclick="window.picked = (async () => {
      const el = document.createElement('input');
      el.type = 'file';
      el.click();
      await new Promise(x => el.oninput = x);
      const reader = new FileReader();
      const promise = new Promise(fulfill => reader.onload = fulfill);
      reader.readAsText(el.files[0]);
      return promise.then(() => reader.result);
    })()">pick</button>`));
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate('() => window.picked')).toBe('contents of the file');
  });

  test('should accept single file', async ({ browser }) => {
    await browser.goto(content("<input type=file oninput='javascript:console.timeStamp()'><button onclick=\"document.querySelector('input').click()\">pick</button>"));
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files.length")).toBe(1);
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
  });

  test('should be able to read selected file', async ({ browser }) => {
    await browser.goto(content(PICKER));
    await browser.evaluate(readPicked);
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate('() => window.picked')).toBe('contents of the file');
  });

  test('should be able to reset selected files with empty file list', async ({ browser }) => {
    await browser.goto(content(PICKER));
    const watchLength = "() => { const picker = document.querySelector('input'); window.picked = new Promise((x) => { picker.oninput = x; }).then(() => picker.files.length); }";
    await browser.evaluate(watchLength);
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate('() => window.picked')).toBe(1);
    await browser.evaluate(watchLength);
    await browser.locator('button').setInputFiles([]);
    expect(await browser.evaluate('() => window.picked')).toBe(0);
  });

  test('should emit event after navigation', async ({ browser }) => {
    await browser.goto(`${PREFIX}/empty.html`);
    await browser.goto(content(PICKER));
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files.length")).toBe(1);
    await browser.goto(`${CROSS}/empty.html`);
    await browser.goto(`${CROSS}${content(PICKER)}`);
    await browser.locator('button').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files.length")).toBe(1);
  });
});
