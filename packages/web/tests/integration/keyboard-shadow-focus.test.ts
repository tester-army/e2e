/** Focused typing validates the actual control inside open and recorded closed shadow roots. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const surface = new PlaywrightSurface({});
const signal = new AbortController().signal;
const operation = () => ({ runId: 'focus', attemptId: 'focus-1', origin: 'test' as const, signal, timeoutMs: 5_000 });
const cleanup = () => ({ signal, timeoutMs: 30_000 });
let artifactsDir: string;
let page: Page;

beforeAll(async () => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-keyboard-shadow-'));
  await surface.init({ runId: 'focus', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  await surface.startAttempt({ attemptId: 'focus-1', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
  await surface.open('about:blank', operation());
  page = surface.requirePage();
});

beforeEach(async () => { await page.goto('about:blank'); });

afterAll(async () => {
  await surface.dispose(cleanup());
  rmSync(artifactsDir, { recursive: true, force: true });
});

async function focusShadow(shadowMode: ShadowRootMode, markup: string): Promise<void> {
  await page.evaluate(({ mode, html }) => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.getElementById('inner')!.attachShadow({ mode });
    inner.innerHTML = html;
    const field = inner.querySelector<HTMLElement>('input,button,[tabindex]')!;
    field.focus();
    field.addEventListener('keydown', () => { document.body.dataset.keys = String(Number(document.body.dataset.keys ?? 0) + 1); });
    field.addEventListener('input', () => { document.body.dataset.value = (field as HTMLInputElement).value; });
  }, { mode: shadowMode, html: markup });
}

describe.each(['open', 'closed'] as const)('%s shadow focus', (mode) => {
  it.each(['<button>Stop</button>', '<input readonly value="kept">'])('refuses a noneditable focused leaf: %s', async (html) => {
    await focusShadow(mode, html);
    await expect(surface.typeText('lost', { replace: true }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await page.getAttribute('body', 'data-keys')).toBeNull();
    expect(await page.getAttribute('body', 'data-value')).toBeNull();
  });

  it('types into a nested editable leaf', async () => {
    await focusShadow(mode, '<input value="before">');
    await surface.typeText('after', { replace: true }, operation());
    expect(await page.getAttribute('body', 'data-value')).toBe('after');
  });

  it('retains focused custom widgets that opt into keystrokes', async () => {
    await focusShadow(mode, '<div tabindex="0">Custom widget</div>');
    await surface.typeText('a', { replace: false }, operation());
    expect(await page.getAttribute('body', 'data-keys')).toBe('1');
  });
});

it('does not mistake the iframe host for an editable control when its button has focus', async () => {
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise<void>((resolve) => { frame.addEventListener('load', () => resolve(), { once: true }); });
    frame.srcdoc = '<button id="stop">Stop</button>';
    document.body.append(frame);
    await loaded;
    frame.contentDocument!.getElementById('stop')!.focus();
  });
  await expect(surface.typeText('lost', { replace: false }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
});
