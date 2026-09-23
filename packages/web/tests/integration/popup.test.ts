/**
 * `web.waitForPopup` through the engine's own surface: the page the app opens
 * becomes the attempt's active page, so every read, query, action, capture,
 * and dialog follows it, and closing it returns to the opener with the
 * opener's state intact. No runner involved: the `web` fixture is driven
 * with a minimal fixture context, and screen queries are the `locate` and
 * `observe` calls they compile to.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, FixtureOperations, LocatorExpression, OperationContext, SemanticNode } from 'e2e/engine';
import { TestError } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createWebFixture, type Web, type WebExpectation } from '../../src/web.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

const signal = new AbortController().signal;

function operation(timeoutMs = 10_000): OperationContext {
  return { signal, timeoutMs, runId: 'run-popup', attemptId: 'a1', origin: 'test' };
}

function byRole(role: string, name?: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: role, exact: true },
      ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: true } }),
    },
  };
}

/** Depth-first names of one observation tree. */
function* names(node: SemanticNode): Generator<string> {
  if (node.name !== undefined) yield node.name;
  for (const child of node.children ?? []) yield* names(child);
}

describe('web.waitForPopup', () => {
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-popup-'));
  let app: FixtureApp;
  let web: Web;
  let matchers: WebExpectation;
  let recorded: string[];

  beforeAll(async () => {
    app = await startFixtureApp();
    await surface.init({ runId: 'run-popup', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'a1', artifactsDir, signal });
    recorded = [];
    const context = {
      targetName: 'web',
      operation,
      timeouts: { test: 30_000, action: 10_000, assertion: 5_000 },
      signal,
      app: { url: app.url, resolveUrl: (url: string) => new URL(url, app.url).href },
      attachArtifact: () => undefined,
      attachViewport: () => undefined,
      expectable: (target: object, factory: () => object) => Object.assign(target, { matchers: factory }),
      fixture: (name: string, target: object, operations: FixtureOperations<object>) => {
        recorded.push(...Object.keys(operations).filter((key) => key !== 'not').map((key) => `${name}.${key}`));
        return target;
      },
    } as unknown as EngineFixtureContext;
    web = createWebFixture(surface, context);
    matchers = (web as unknown as { matchers(): WebExpectation }).matchers();
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Taps the one node the query matches, through the contract's own action path. */
  async function tap(expression: LocatorExpression): Promise<void> {
    const [node] = await surface.locate(expression, operation());
    expect(node).toBeDefined();
    await surface.perform(node!.ref, { kind: 'tap' }, operation());
  }

  async function headingName(): Promise<string | undefined> {
    const [heading] = await surface.locate(byRole('heading'), operation());
    return heading?.name;
  }

  it('makes the page window.open opened the active one, and close() returns to the opener as it was', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const opener = surface.requirePage();
    await opener.fill('#draft', 'edited');

    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open window')));

    expect(popup.url).toBe(`${app.url}/popup`);
    expect(await web.url()).toBe(`${app.url}/popup`);
    expect(await web.title()).toBe('Fixture Popup');
    await matchers.toHaveURL('/popup');
    await matchers.toHaveTitle('Fixture Popup');
    await matchers.not.toHaveTitle('Fixture Opener');
    expect(await headingName()).toBe('Popup');
    const observed = [...names((await surface.observe(operation())).root)];
    expect(observed).toContain('Popup');
    expect(observed).not.toContain('Opener');
    const popupPage = surface.requirePage();
    expect(popupPage).not.toBe(opener);
    expect(await surface.screenshot('in-popup', operation())).toMatch(/^screenshots\/.*in-popup\.png$/);

    await popup.close();

    expect(popupPage.isClosed()).toBe(true);
    expect(surface.requirePage()).toBe(opener);
    expect(await web.url()).toBe(`${app.url}/opener`);
    await matchers.toHaveTitle('Fixture Opener');
    expect(await headingName()).toBe('Opener');
    expect(await opener.inputValue('#draft')).toBe('edited');
    expect(await opener.textContent('#count')).toBe('1');
    expect(recorded).toContain('web.waitForPopup');
    expect(recorded).toContain('popup.close');
  });

  it('follows a link with target=_blank the same way', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const popup = await web.waitForPopup(() => tap(byRole('link', 'Open link')));
    expect(popup.url).toBe(`${app.url}/popup`);
    expect(await headingName()).toBe('Popup');
    await popup.close();
    expect(await headingName()).toBe('Opener');
  });

  it('reads a blank window the opener wrote into, as a verification-code flow does', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open written')));
    expect(popup.url).toBe('about:blank');
    await matchers.toHaveTitle('Written');
    expect(await headingName()).toBe('Written popup');
    expect(await web.evaluate(() => document.getElementById('code')?.textContent ?? null)).toBe('TAB-88421');
    await popup.close();
    expect(await headingName()).toBe('Opener');
  });

  it('routes a dialog the popup opens to the attempt handler, which sees its kind', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const kinds: string[] = [];
    const off = await web.onDialog((dialog) => {
      kinds.push(dialog.type);
      return dialog.accept();
    });
    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    await tap(byRole('button', 'Ask'));
    expect(await surface.requirePage().textContent('#popup-answer')).toBe('yes');
    expect(kinds).toEqual(['confirm']);
    await popup.close();
    await off();
  });

  it('fails a trigger that opens no page within the timeout and keeps the opener active', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const started = Date.now();
    await expect(web.waitForPopup(() => tap(byRole('button', 'Open nothing')), { timeout: 800 }))
      .rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringMatching(/^popup timed out/) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await web.title()).toBe('Fixture Opener');
    expect(await surface.requirePage().textContent('#count')).toBe('no window');

    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    expect(await headingName()).toBe('Popup');
    await popup.close();
  });

  it("keeps a failing trigger's own error", async () => {
    await surface.open(`${app.url}/opener`, operation());
    const failure = new TestError('ACTION_FAILED', 'the trigger failed');
    await expect(web.waitForPopup(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(await web.title()).toBe('Fixture Opener');
  });

  it('leaves a page opened with no wait pending alone', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const opener = surface.requirePage();
    const opened = surface.requireContext().waitForEvent('page');
    await tap(byRole('button', 'Open window'));
    const stray = await opened;
    await stray.waitForLoadState('load');

    expect(surface.requirePage()).toBe(opener);
    expect(await web.title()).toBe('Fixture Opener');
    expect(await headingName()).toBe('Opener');
    expect(stray.isClosed()).toBe(false);
    expect(surface.requireContext().pages()).toHaveLength(2);
  });

  it('returns to the opener when the app closes the popup itself; close() is then a no-op', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const opener = surface.requirePage();
    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    const popupPage = surface.requirePage();
    const closed = popupPage.waitForEvent('close');
    await tap(byRole('button', 'Close me'));
    await closed;

    expect(surface.requirePage()).toBe(opener);
    expect(await web.title()).toBe('Fixture Opener');
    await popup.close();
    expect(surface.requirePage()).toBe(opener);
    expect(await headingName()).toBe('Opener');
  });

  it('nests: a popup opened from a popup returns to that popup, then to the opener', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const first = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    await web.goto('/opener');
    const second = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    const pages = surface.requireContext().pages();
    expect(pages).toHaveLength(3);
    expect(await headingName()).toBe('Popup');
    await second.close();
    expect(await web.url()).toBe(`${app.url}/opener`);
    expect(surface.requirePage()).toBe(pages[1]);
    await first.close();
    expect(surface.requirePage()).toBe(pages[0]);
  });

  it('closes popups out of order: the first closed under the second leaves the second active, then the opener returns', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const first = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    await web.goto('/opener');
    const second = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    const pages = surface.requireContext().pages();
    expect(pages).toHaveLength(3);
    await first.close();
    expect(pages[1]!.isClosed()).toBe(true);
    expect(surface.requirePage()).toBe(pages[2]);
    expect(await headingName()).toBe('Popup');
    await second.close();
    expect(surface.requirePage()).toBe(pages[0]);
    expect(await headingName()).toBe('Opener');
    expect(await web.title()).toBe('Fixture Opener');
  });

  it('reads the popup URL as it is now, after the popup redirected', async () => {
    await surface.open(`${app.url}/opener`, operation());
    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open redirecting')));
    await matchers.toHaveURL('/popup');
    expect(popup.url).toBe(`${app.url}/popup`);
    expect(await headingName()).toBe('Popup');
    await popup.close();
    // Gone, the handle still says where the popup was.
    expect(popup.url).toBe(`${app.url}/popup`);
    expect(await headingName()).toBe('Opener');
  });

  it('records the popup as its own video segment, between two of the opener', async () => {
    await surface.open(`${app.url}/opener`, operation());
    await surface.startVideo(operation());
    const popup = await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    await matchers.toHaveTitle('Fixture Popup');
    await popup.close();
    await matchers.toHaveTitle('Fixture Opener');
    const segments = await surface.stopVideo(operation());
    expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm', 'video/video-part3.webm']);
  });

  it('drops the segment of a popup the app closed itself and keeps recording the opener', async () => {
    await surface.open(`${app.url}/opener`, operation());
    await surface.startVideo(operation());
    const opener = surface.requirePage();
    await web.waitForPopup(() => tap(byRole('button', 'Open window')));
    const popupPage = surface.requirePage();
    const closed = popupPage.waitForEvent('close');
    await tap(byRole('button', 'Close me'));
    await closed;
    expect(surface.requirePage()).toBe(opener);
    await matchers.toHaveTitle('Fixture Opener');
    // Collection succeeds either way: a screencast whose page closed under it
    // may have flushed frames (the segment is kept) or nothing (it is dropped).
    const segments = await surface.stopVideo(operation());
    const paths = segments.map((segment) => segment.path);
    expect(paths[0]).toBe('video/video.webm');
    expect(paths.at(-1)).toBe('video/video-part3.webm');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.length).toBeLessThanOrEqual(3);
  });

  it('refuses to wait before an app page is open', async () => {
    await expect(web.waitForPopup(async () => undefined)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('hands a dialog handler the kind of every dialog the page opens', async () => {
    await surface.open(`${app.url}/dialogs`, operation());
    const page: Page = surface.requirePage();
    const seen: { type: string; message: string }[] = [];
    const off = await web.onDialog((dialog) => {
      seen.push({ type: dialog.type, message: dialog.message });
      switch (dialog.type) {
        case 'prompt': return dialog.accept('ada');
        case 'confirm': return dialog.accept();
        default: return dialog.dismiss();
      }
    });
    await tap(byRole('button', 'Alert'));
    expect(await page.textContent('#answer')).toBe('alerted');
    await tap(byRole('button', 'Confirm'));
    expect(await page.textContent('#answer')).toBe('confirmed');
    await tap(byRole('button', 'Prompt'));
    expect(await page.textContent('#answer')).toBe('ada');
    expect(seen).toEqual([
      { type: 'alert', message: 'heads up' },
      { type: 'confirm', message: 'proceed?' },
      { type: 'prompt', message: 'name?' },
    ]);
    await off();
  });
});
