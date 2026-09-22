/**
 * A `frameLocator` chain resolves each frame inside the one before it: the
 * inner selector is looked up in the outer frame's document, never in the
 * page, so validation and Playwright's own `frameLocator` chain agree.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { surfaceOf, web } from '../../src/index.ts';

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `web.frameLocator` chain does. */
function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}

const TWIN_FRAME = '<iframe class="twin" title="twin" srcdoc="<p>twin</p>"></iframe>';
const DEEP_DOCUMENT = '<button>Deep button</button>';
const INNER_DOCUMENT =
  '<button onclick="this.textContent = \'Inner clicked\'">Inner button</button>' +
  `<iframe id="deep" title="deep" srcdoc="${attribute(DEEP_DOCUMENT)}"></iframe>`;
const OUTER_DOCUMENT =
  `<h2>Outer</h2><iframe id="inner" title="inner" srcdoc="${attribute(INNER_DOCUMENT)}"></iframe>` +
  TWIN_FRAME +
  TWIN_FRAME;
const HOST_DOCUMENT =
  '<h1>Host</h1><iframe id="aside" title="aside" srcdoc="<p>aside</p>"></iframe>' +
  TWIN_FRAME +
  `<iframe id="outer" title="outer" srcdoc="${attribute(OUTER_DOCUMENT)}"></iframe>`;

/** A role query for the one button named `name`. */
function buttonNamed(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

const INNER_BUTTON = buttonNamed('Inner button');
const DEEP_BUTTON = buttonNamed('Deep button');

describe('nested frame locators', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-nested-frames-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'frames', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let page: Page;

  beforeAll(async () => {
    await engine.init!({ runId: 'frames', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal });
    await engine.session!.open!('about:blank', operation);
    page = surfaceOf(engine)!.page();
    await page.setContent(HOST_DOCUMENT);
    await page
      .frameLocator('#outer')
      .frameLocator('#inner')
      .frameLocator('#deep')
      .getByRole('button', { name: 'Deep button' })
      .waitFor();
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('resolves a two-level chain and taps inside the innermost frame', async () => {
    const matches = await engine.locate!(withinFrames(['#outer', '#inner'], INNER_BUTTON), operation);
    expect(matches.map((node) => node.name)).toEqual(['Inner button']);
    await engine.perform!(matches[0]!.ref, { kind: 'tap' }, operation);
    expect(await page.frameLocator('#outer').frameLocator('#inner').getByRole('button').innerText()).toBe('Inner clicked');
  });

  it('resolves a three-level chain, counting the last frame inside the second', async () => {
    const matches = await engine.locate!(withinFrames(['#outer', '#inner', '#deep'], DEEP_BUTTON), operation);
    expect(matches.map((node) => node.name)).toEqual(['Deep button']);
    await expect(engine.locate!(withinFrames(['#outer', '#deep'], DEEP_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #deep',
    });
  });

  it('names the inner selector when the outer frame holds no such frame, even though the page does', async () => {
    await expect(engine.locate!(withinFrames(['#outer', '#aside'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #aside',
      retryable: true,
    });
  });

  it('reports two matching frames inside the outer document as ambiguous, though the page holds one', async () => {
    expect(await page.locator('.twin').count()).toBe(1);
    await expect(engine.locate!(withinFrames(['#outer', '.twin'], INNER_BUTTON), operation)).rejects.toMatchObject({
      code: 'FRAME_AMBIGUOUS',
      message: '2 frames match .twin',
      retryable: false,
    });
  });
});
