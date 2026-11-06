/**
 * `setInputFiles` against a real page, for both callers the engine acts for,
 * a test's step and the agent: a file input and a label for one take the files without a
 * click, a button that opens a hidden input's chooser is clicked and the
 * chooser takes them, an empty list clears either, and a button that opens
 * nothing fails.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NodeRef } from 'e2e/engine';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
let file: string;

beforeAll(async () => {
  session = await startWebSession({ startAttempt: false });
  file = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-upload-')), 'avatar.png');
  writeFileSync(file, 'png');
});

afterAll(async () => {
  await session.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

beforeEach(async () => {
  await session.startAttempt();
});

const KINDS = ['test', 'agent'] as const;

/** The caller an action runs for and the node it acts on. */
interface Target {
  readonly origin: (typeof KINDS)[number];
  readonly ref: NodeRef;
}

/** The one node `selector` locates, acted on for `origin`. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<Target> {
  const [node, ...rest] = await session.locate(bySelector(selector));
  if (node === undefined || rest.length > 0) throw new Error(`expected one node for ${selector}`);
  return { origin: kind, ref: node.ref };
}

/** Uploads `paths`, the fixture file by default, and returns the contract error it failed with, as the engine reports it. */
async function upload(target: Target, paths: readonly string[] = [file]): Promise<Error | undefined> {
  try {
    await session.engine.perform!(target.ref, { kind: 'setInputFiles', paths }, { ...session.op(2_000), origin: target.origin });
    return undefined;
  } catch (cause) {
    return cause as Error;
  }
}

/** The page's record of the file the input holds and the clicks it saw. */
function state(): Promise<{ files: string; clicks: number }> {
  return session.browser.evaluate(() => ({
    files: Array.from(document.querySelector<HTMLInputElement>('#avatar')!.files ?? [], (picked) => picked.name).join(', '),
    clicks: (window as unknown as { clicks: number }).clicks,
  }));
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('for the %s', (kind) => {
  it('sets a file input directly', async () => {
    await session.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#avatar'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('sets the input a label names without clicking the label', async () => {
    await session.setContent(`<label id="pick" for="avatar">Choose avatar</label><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('clicks a button over a hidden input and sets the files through its chooser', async () => {
    await session.setContent(`
      <button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button>
      <input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect((await state()).files).toBe('avatar.png');
  });

  it.for([
    ['a file input', '<input id="avatar" type="file">', '#avatar'],
    ['a button over a hidden input', `<button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button><input id="avatar" type="file" hidden>`, '#pick'],
  ] as const)('clears %s with an empty list and fires input and change', async ([_name, html, selector]) => {
    await session.setContent(`${html}${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, selector))).toBeUndefined();
    await session.browser.evaluate(() => {
      const events: string[] = [];
      (window as unknown as { events: string[] }).events = events;
      const input = document.querySelector('#avatar')!;
      input.addEventListener('input', () => events.push('input'));
      input.addEventListener('change', () => events.push('change'));
      return null;
    });
    expect(await upload(await targetOf(kind, selector), [])).toBeUndefined();
    expect((await state()).files).toBe('');
    expect(await session.browser.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['input', 'change']);
  });

  it('fails when the button opens no file chooser', async () => {
    await session.setContent(`<button id="pick" type="button">Choose avatar</button><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    const error = await upload(await targetOf(kind, '#pick'));
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('opened no file chooser') });
    expect((await state()).files).toBe('');
  });
});
