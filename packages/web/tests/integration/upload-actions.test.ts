/**
 * `setInputFiles` against a real page, through both kinds of target the
 * engine acts on: a file input and a label for one take the files without a
 * click, a button that opens a hidden input's chooser is clicked and the
 * chooser takes them, and a button that opens nothing fails.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyActionError, dispatchLocatorAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

let browser: Browser;
let page: Page;
let file: string;

beforeAll(async () => {
  browser = await chromium.launch();
  file = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-upload-')), 'avatar.png');
  writeFileSync(file, 'png');
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
});

const KINDS = ['locator', 'element'] as const;

/** The control as the engine would hold it: a locator, or an element handle pinned by an observation. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<ActionTarget> {
  const locator = page.locator(selector);
  if (kind === 'locator') return { kind, locator };
  const element = await locator.elementHandle();
  if (element === null) throw new Error(`no element for ${selector}`);
  return { kind, element };
}

/** Uploads the fixture file and returns the contract error it failed with, classified as the engine reports it. */
async function upload(target: ActionTarget): Promise<Error | undefined> {
  const action = { kind: 'setInputFiles', paths: [file] } as const;
  try {
    await dispatchLocatorAction(target, action, { timeoutMs: 2000, signal: new AbortController().signal }, () => {
      throw new Error('no second target');
    });
    return undefined;
  } catch (cause) {
    return classifyActionError(cause, action);
  }
}

/** The page's record of the file the input holds and the clicks it saw. */
function state(): Promise<{ files: string; clicks: number }> {
  return page.evaluate(() => ({
    files: Array.from(document.querySelector<HTMLInputElement>('#avatar')!.files ?? [], (picked) => picked.name).join(', '),
    clicks: (window as unknown as { clicks: number }).clicks,
  }));
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('through the %s target', (kind) => {
  it('sets a file input directly', async () => {
    await page.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#avatar'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('sets the input a label names without clicking the label', async () => {
    await page.setContent(`<label id="pick" for="avatar">Choose avatar</label><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('clicks a button over a hidden input and sets the files through its chooser', async () => {
    await page.setContent(`
      <button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button>
      <input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect((await state()).files).toBe('avatar.png');
  });

  it('fails when the button opens no file chooser', async () => {
    await page.setContent(`<button id="pick" type="button">Choose avatar</button><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    const error = await upload(await targetOf(kind, '#pick'));
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('opened no file chooser') });
    expect((await state()).files).toBe('');
  });
});
