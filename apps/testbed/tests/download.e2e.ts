/**
 * Adapted from microsoft/playwright tests/library/download.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.waitForEvent('download')` is `browser.waitForDownload(trigger)`,
 * which saves the file, and `download.path()` is the saved file's `absolutePath`. e2e has no
 * `download.url()`, so its assertions are dropped.
 */

/*
 * Not ported:
 * - should report downloads with acceptDownloads: false: e2e always accepts downloads.
 * - should report proper download url when download is from download attribute: needs `download.url()`.
 * - should save to user-specified path without updating original path: needs `download.saveAs`.
 * - should save to two different paths with multiple saveAs calls: needs `download.saveAs`.
 * - should save to overwritten filepath: needs `download.saveAs`.
 * - should create subdirectories when saving to non-existent user-specified path: needs `download.saveAs`.
 * - should error when saving with downloads disabled: needs `acceptDownloads: false` and `download.saveAs`.
 * - should error when saving after deletion: needs `download.delete` and `download.saveAs`.
 * - should delete file: needs `download.delete`.
 * - should expose stream: needs `download.createReadStream`.
 * - should delete downloads on context destruction: needs `context.close` from the test.
 * - should delete downloads on browser gone: needs `browserType.launch` from the test.
 * - should save downloads to artifactsDir: needs `browserType.launch({ artifactsDir })`.
 * - should close the context without awaiting the failed download: needs `context.close` and an HTTPS server.
 * - should close the context without awaiting the download: needs `context.close` and `download.failure`.
 * - should throw if browser dies: needs `browser.close` from the test.
 * - should be able to cancel pending downloads: needs `download.cancel` and `download.failure`.
 * - should not fail explicitly to cancel a download even if that is already finished: needs `download.cancel`.
 * - should save to user-specified path: needs `download.saveAs`.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import fs from 'node:fs';
import path from 'node:path';
import { asset, content, PREFIX } from './helpers.ts';

/** `/respond` answering with `headers` and `body`. */
function respond(headers: Record<string, string>, body = 'Hello world'): string {
  return `/respond?headers=${encodeURIComponent(JSON.stringify(headers))}&body=${encodeURIComponent(body)}`;
}

/** Checks a saved download is the file at `filePath` byte for byte, PDF magic first, Playwright's `assertDownloadToPDF`. */
function assertDownloadToPDF(download: { absolutePath: string; suggestedFilename: string }, filePath: string): void {
  expect(download.suggestedFilename).toBe(path.basename(filePath));
  const data = fs.readFileSync(download.absolutePath);
  const expectedPrefix = '%PDF';
  for (let i = 0; i < expectedPrefix.length; i++) expect(data[i]).toBe(expectedPrefix.charCodeAt(i));
  expect(data.equals(fs.readFileSync(filePath))).toBe(true);
}

test.describe('download event', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should report download when navigation turns into download @smoke', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto('/empty.html');
    let responseOrError: unknown;
    const download = await browser.waitForDownload(async () => {
      responseOrError = await browser.goto(`${PREFIX}/download`).catch((caught: Error) => caught);
    });
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
    expect(responseOrError instanceof Error).toBeTruthy();
    expect((responseOrError as Error).message).toContain('Download is starting');
    expect(await browser.url()).toBe(`${PREFIX}/empty.html`);
  });

  test('should work with Cross-Origin-Opener-Policy', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto('/empty.html');
    let responseOrError: unknown;
    const url = respond({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'cross-origin-opener-policy': 'same-origin' });
    const download = await browser.waitForDownload(async () => {
      responseOrError = await browser.goto(url).catch((caught: Error) => caught);
    });
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
    expect(responseOrError instanceof Error).toBeTruthy();
    expect((responseOrError as Error).message).toContain('Download is starting');
    expect(await browser.url()).toBe(`${PREFIX}/empty.html`);
  });

  test('should report downloads with acceptDownloads: true', async ({ browser }) => {
    await browser.goto(content(`<a href="${PREFIX}/download">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test('should report downloads for download attribute', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`<a href="${PREFIX}/chromium-linux.zip" download="foo.zip">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(download.suggestedFilename).toBe('foo.zip');
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
  });

  test('should report non-navigation downloads', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`<a download="file.txt" href="${PREFIX}${respond({ 'content-type': 'application/octet-stream' })}">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(download.suggestedFilename).toBe('file.txt');
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test(`should report download path within page.on('download', …) handler for Files`, async ({ browser }) => {
    await browser.goto(content(`<a href="${PREFIX}/download">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test(`should report download path within page.on('download', …) handler for Blobs`, async ({ browser }) => {
    await browser.goto('/download-blob.html');
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test('should report alt-click downloads', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content(`<a href="${PREFIX}${respond({ 'content-type': 'application/octet-stream' })}">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap({ modifiers: ['Alt'] }));
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test('should report new window downloads', async ({ browser }) => {
    await browser.goto(content(`<a target=_blank href="${PREFIX}/download">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
  });

  test('should download large binary.zip', async ({ browser }) => {
    const fileContent = Buffer.alloc(1 << 20);
    for (let i = 0; i < fileContent.length; i++) fileContent[i] = Math.imul(i + 1, 2654435761) >>> 24;
    await browser.goto('/empty.html');
    await browser.goto(content(`<a href="${PREFIX}/binary?bytes=${1 << 20}" download="binary.zip">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    const downloaded = fs.readFileSync(download.absolutePath);
    expect(downloaded.byteLength).toBe(fileContent.byteLength);
    expect(downloaded.equals(fileContent)).toBe(true);
  });

  test('should report downloads with interception', async ({ browser }) => {
    await browser.route(/.*/, (route) => route.continue());
    await browser.goto(content(`<a href="${PREFIX}/download">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });

  test('should emit download event from nested iframes', async ({ browser }) => {
    const third = content(` <a href="${PREFIX}/download">download</a>`);
    const second = content(`<iframe src="${PREFIX}${third}"></iframe>`);
    await browser.goto(content(`<iframe src="${PREFIX}${second}"></iframe>`));
    const download = await browser.waitForDownload(() => browser.frameLocator('iframe').frameLocator('iframe').locator('a').tap());
    expect(fs.existsSync(download.absolutePath)).toBeTruthy();
    expect(fs.readFileSync(download.absolutePath).toString()).toBe('Hello world');
  });
});

test.describe('download', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should be able to download a PDF file', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content('<a href="/empty.pdf" download>download</a>'));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    assertDownloadToPDF(download, asset('empty.pdf'));
  });

  test('should be able to download a inline PDF file via response interception', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.route('**/empty.pdf', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        status: response.status,
        headers: { ...response.headers, 'Content-Disposition': 'attachment' },
        body: await response.body(),
      });
    });
    await browser.goto(content('<a href="/empty.pdf">open</a>'));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    assertDownloadToPDF(download, asset('empty.pdf'));
  });

  test('should be able to download a inline PDF file via navigation', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content('<a href="/empty.pdf">open</a>'));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    assertDownloadToPDF(download, asset('empty.pdf'));
  });

  test('should download even if there is no "attachment" value', async ({ browser }) => {
    await browser.goto(content(`<a href="${PREFIX}${respond({ 'content-type': 'application/octet-stream', 'content-disposition': 'filename=foo.txt' })}">download</a>`));
    await browser.waitForDownload(() => browser.locator('a').tap());
  });

  test('should convert navigation to a resource with unsupported mime type into download', async ({ browser }) => {
    // e2e opens no page before the first goto, where Playwright starts on about:blank.
    await browser.goto('/empty.html');
    await browser.waitForDownload(async () => {
      await browser.goto(respond({ 'content-type': 'application/octet-stream' })).catch(() => undefined);
    });
  });

  test('should download links with data url', async ({ browser }) => {
    await browser.goto(content('<a download="SomeFile.txt" href="data:text/plain;charset=utf8;,hello world">Download!</a>'));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(download.suggestedFilename).toBe('SomeFile.txt');
  });

  test('should download successfully when routing', async ({ browser }) => {
    await browser.route('**/*', (route) => route.continue());
    await browser.goto('/empty.html');
    await browser.goto(content(`<a href="${PREFIX}/chromium-linux.zip" download="foo.zip">download</a>`));
    const download = await browser.waitForDownload(() => browser.locator('a').tap());
    expect(download.suggestedFilename).toBe('foo.zip');
  });
});
