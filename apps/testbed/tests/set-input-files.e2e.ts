/**
 * Adapted from microsoft/playwright tests/page/page-set-input-files.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `setInputFiles` is the locator's, its paths resolve from the project
 * root, and what the server received is what `/upload` answers with.
 */

/*
 * Not ported:
 * - should set from memory: `setInputFiles` takes file paths, not `{ name, mimeType, buffer }` payloads.
 * - input event.composed should be true and cross shadow dom boundary: sets a `{ name, mimeType, buffer }` payload, whose events Playwright dispatches itself.
 */

import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asset, content, PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

type UploadedFile = { name: string; filename?: string; mimetype?: string; size: number; base64?: string };

/** Reads the first file of the input `selector` matches as text, in the page. */
const readFirstFile = (selector: string): string => `() => {
  const reader = new FileReader();
  const promise = new Promise((fulfill) => { reader.onload = fulfill; });
  reader.readAsText(document.querySelector(${JSON.stringify(selector)}).files[0]);
  return promise.then(() => reader.result);
}`;

const outputDirs: string[] = [];

/** A fresh directory for files a test writes, removed after the test. */
function outputDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-upload-'));
  outputDirs.push(dir);
  return dir;
}

/** Writes a 200MB file of `A`s, Playwright's large upload. */
async function writeLargeFile(file: string): Promise<void> {
  const str = 'A'.repeat(4 * 1024);
  const stream = fs.createWriteStream(file);
  for (let i = 0; i < 50 * 1024; i++) {
    await new Promise<void>((fulfill, reject) => stream.write(str, (error) => (error ? reject(error) : fulfill())));
  }
  await new Promise((fulfill) => stream.end(fulfill));
}

/** The files the server parsed from the form the page posted to `/upload`. */
async function uploaded(browser: Browser): Promise<UploadedFile[]> {
  return JSON.parse(await browser.evaluate<string>('document.body.textContent')) as UploadedFile[];
}

/** Records the input and change events the input `selector` matches dispatches, into `window.events`. */
const recordEvents = (selector: string): string => `() => {
  window.events = [];
  const e = document.querySelector(${JSON.stringify(selector)});
  e.addEventListener('input', () => window.events.push('input'));
  e.addEventListener('change', () => window.events.push('change'));
}`;

test.describe('page set input files', { requires: ['browser'], tags: ['playwright'] }, () => {
  test.afterEach(() => {
    for (const dir of outputDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('should upload the file', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
    expect(await browser.evaluate(readFirstFile('input'))).toBe('contents of the file');
  });

  test('should upload a folder', async ({ browser }) => {
    await browser.goto('/input/folderupload.html');
    const dir = path.join(outputDir(), 'file-upload-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file1.txt'), 'file1 content');
    fs.writeFileSync(path.join(dir, 'file2'), 'file2 content');
    fs.mkdirSync(path.join(dir, 'sub-dir'));
    fs.writeFileSync(path.join(dir, 'sub-dir', 'really.txt'), 'sub-dir file content');
    await browser.locator('input[type=file]').setInputFiles(dir);
    const webkitRelativePaths = await browser.evaluate<string[]>("() => [...document.querySelector('input').files].map((f) => f.webkitRelativePath)");
    expect(new Set(webkitRelativePaths)).toEqual(new Set([
      'file-upload-test/sub-dir/really.txt',
      'file-upload-test/file1.txt',
      'file-upload-test/file2',
    ]));
    for (let i = 0; i < webkitRelativePaths.length; i++) {
      const fileContent = await browser.evaluate(`(i) => {
        const reader = new FileReader();
        const promise = new Promise((fulfill) => { reader.onload = fulfill; });
        reader.readAsText(document.querySelector('input').files[i]);
        return promise.then(() => reader.result);
      }`, i);
      expect(fileContent).toEqual(fs.readFileSync(path.join(dir, '..', webkitRelativePaths[i]!)).toString());
    }
  });

  test('should upload a folder and throw for multiple directories', async ({ browser }) => {
    await browser.goto('/input/folderupload.html');
    const dir = path.join(outputDir(), 'file-upload-test');
    fs.mkdirSync(path.join(dir, 'folder1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'folder1', 'file1.txt'), 'file1 content');
    fs.mkdirSync(path.join(dir, 'folder2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'folder2', 'file2.txt'), 'file2 content');
    const error = await browser.locator('input[type=file]').setInputFiles([path.join(dir, 'folder1'), path.join(dir, 'folder2')]).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Multiple directories are not supported');
  });

  test('should throw if a directory and files are passed', async ({ browser }) => {
    await browser.goto('/input/folderupload.html');
    const dir = path.join(outputDir(), 'file-upload-test');
    fs.mkdirSync(path.join(dir, 'folder1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'folder1', 'file1.txt'), 'file1 content');
    const error = await browser.locator('input[type=file]').setInputFiles([path.join(dir, 'folder1'), path.join(dir, 'folder1', 'file1.txt')]).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('File paths must be all files or a single directory');
  });

  test('should throw when uploading a folder in a normal file upload input', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    const dir = path.join(outputDir(), 'file-upload-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file1.txt'), 'file1 content');
    const error = await browser.locator('input[type=file]').setInputFiles(dir).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('File input does not support directories, pass individual files instead');
  });

  test('should throw when uploading a file in a directory upload input', async ({ browser }) => {
    await browser.goto('/input/folderupload.html');
    const error = await browser.locator('input[type=file]').setInputFiles(asset('file to upload.txt')).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('[webkitdirectory] input requires passing a path to a directory');
  });

  test('should upload a file after popup', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    await browser.evaluate("() => { window['__popup'] = window.open('about:blank'); }");
    await browser.evaluate("() => { window['__popup'].close(); }");
    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
  });

  test('should upload large file', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    const uploadFile = path.join(outputDir(), '200MB.zip');
    await writeLargeFile(uploadFile);
    await browser.evaluate(recordEvents('input[type="file"]'));
    await browser.locator('input[type="file"]').setInputFiles(uploadFile);
    expect(await browser.evaluate("() => document.querySelector('input[type=\"file\"]').files[0].name")).toBe('200MB.zip');
    expect(await browser.evaluate('() => window.events')).toEqual(['input', 'change']);
    await Promise.all([
      browser.waitForURL('/upload'),
      browser.locator('input[type=submit]').tap(),
    ]);
    const [file1] = await uploaded(browser);
    expect(file1!.filename).toBe('200MB.zip');
    expect(file1!.size).toBe(200 * 1024 * 1024);
    fs.unlinkSync(uploadFile);
  });

  test('should throw an error if the file does not exist', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    const error = await browser.locator('input[type=file]').setInputFiles('i actually do not exist.txt').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('ENOENT: no such file or directory');
    expect((error as Error).message).toContain('i actually do not exist.txt');
  });

  test('should upload large file with relative path', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    const uploadFile = path.join(outputDir(), '200MB.zip');
    await writeLargeFile(uploadFile);
    await browser.evaluate(recordEvents('input[type="file"]'));
    const relativeUploadPath = path.relative(process.cwd(), uploadFile);
    expect(path.isAbsolute(relativeUploadPath)).toBeFalsy();
    await browser.locator('input[type="file"]').setInputFiles(relativeUploadPath);
    expect(await browser.evaluate("() => document.querySelector('input[type=\"file\"]').files[0].name")).toBe('200MB.zip');
    expect(await browser.evaluate('() => window.events')).toEqual(['input', 'change']);
    await Promise.all([
      browser.waitForURL('/upload'),
      browser.locator('input[type=submit]').tap(),
    ]);
    const [file1] = await uploaded(browser);
    expect(file1!.filename).toBe('200MB.zip');
    expect(file1!.size).toBe(200 * 1024 * 1024);
    fs.unlinkSync(uploadFile);
  });

  test('should upload the file with spaces in name', async ({ browser }) => {
    await browser.goto('/input/fileupload.html');
    await browser.locator('input[type=file]').setInputFiles(asset('file to upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file to upload.txt');
    expect(await browser.evaluate(readFirstFile('input'))).toBe('contents of the file');
  });

  test('should work @smoke', async ({ browser }) => {
    await browser.goto(content('<input type=file>'));
    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files.length")).toBe(1);
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
  });

  test('should work with CSP', async ({ browser }) => {
    await browser.goto(`/respond?headers=${encodeURIComponent(JSON.stringify({ 'content-type': 'text/html', 'content-security-policy': 'default-src "none"' }))}&body=${encodeURIComponent('<input type=file>')}`);
    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files.length")).toBe(1);
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
  });

  test('should detect mime type', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    await browser.goto(content(`
      <form action="/upload" method="post" enctype="multipart/form-data" >
        <input type="file" name="file1">
        <input type="file" name="file2">
        <input type="submit" value="Submit">
      </form>`));
    await browser.locator('input[name=file1]').setInputFiles(asset('file-to-upload.txt'));
    await browser.locator('input[name=file2]').setInputFiles(asset('pptr.png'));
    await Promise.all([
      browser.waitForURL('/upload'),
      browser.locator('input[type=submit]').tap(),
    ]);
    const [file1, file2] = await uploaded(browser);
    expect(file1!.filename).toBe('file-to-upload.txt');
    expect(file1!.mimetype).toBe('text/plain');
    expect(Buffer.from(file1!.base64!, 'base64').toString()).toBe(fs.readFileSync(asset('file-to-upload.txt')).toString());
    expect(file2!.filename).toBe('pptr.png');
    expect(file2!.mimetype).toBe('image/png');
    expect(Buffer.from(file2!.base64!, 'base64').toString()).toBe(fs.readFileSync(asset('pptr.png')).toString());
  });

  test('should not trim big uploaded files', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const DATA_SIZE = Math.pow(2, 20);
    const files = await browser.evaluate<UploadedFile[], number>(`async (size) => {
      const body = new FormData();
      body.set('file', new Blob([new Uint8Array(size)]));
      return (await fetch('/upload', { method: 'POST', body })).json();
    }`, DATA_SIZE);
    expect(files[0]!.size).toBe(DATA_SIZE);
  });

  test('should emit input and change events', async ({ browser }) => {
    await browser.goto(content(`
    <input id=input type=file></input>
    <script>
      window.events = [];
      input.addEventListener('input', e => window.events.push({ type: e.type }));
      input.addEventListener('change', e => window.events.push({ type: e.type }));
    </script>`));
    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    const events = await browser.evaluate<{ type: string }[]>('() => window.events');
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('input');
    expect(events[1]!.type).toBe('change');
  });

  test('input should trigger events when files changed second time', async ({ browser }) => {
    await browser.goto(content('<input type=file multiple=true/>'));
    await browser.evaluate(recordEvents('input'));

    await browser.locator('input[type=file]').setInputFiles(asset('file-to-upload.txt'));
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('file-to-upload.txt');
    expect(await browser.evaluate('() => window.events')).toEqual(['input', 'change']);

    await browser.evaluate('() => { window.events.length = 0; }');

    await browser.locator('input[type=file]').setInputFiles(asset('pptr.png'));
    expect(await browser.evaluate("() => document.querySelector('input').files[0].name")).toBe('pptr.png');
    expect(await browser.evaluate('() => window.events')).toEqual(['input', 'change']);
  });

  test('should preserve lastModified timestamp', async ({ browser }) => {
    await browser.goto(content('<input type=file multiple=true/>'));
    const files = ['file-to-upload.txt', 'file-to-upload-2.txt'];
    await browser.locator('input[type=file]').setInputFiles(files.map(asset));
    expect(await browser.evaluate("() => [...document.querySelector('input').files].map((f) => f.name)")).toEqual(files);
    const timestamps = await browser.evaluate<number[]>("() => [...document.querySelector('input').files].map((f) => f.lastModified)");
    const expectedTimestamps = files.map((file) => Math.round(fs.statSync(asset(file)).mtimeMs));
    for (let i = 0; i < timestamps.length; i++) {
      expect(Math.abs(timestamps[i]! - expectedTimestamps[i]!)).toBeLessThanOrEqual(1000);
    }
  });
});
