/**
 * A node inside a hidden frame reads as hidden: the frame element's own
 * `hidden` state, read in the document around it, counts for every node in
 * its document and in the frames nested under it. A `visible` or role query
 * there matches nothing, under an index too, as neither matches a hidden node.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { surfaceOf, web } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}

const BUTTON: LocatorExpression = { kind: 'selector', selector: 'button' };
const ROLE_BUTTON: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } },
};
const VISIBLE_BUTTON: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, visible: true },
};

const DOCUMENT = `
  <iframe id="hidden" style="visibility: hidden" srcdoc="<button>Hidden</button>"></iframe>
  <div style="visibility: hidden">
    <iframe id="hidden-parent" srcdoc="<button>Hidden parent</button>"></iframe>
    <iframe id="override" style="visibility: visible" srcdoc="<button>Override</button>"></iframe>
  </div>
  <iframe id="outer" style="visibility: hidden" srcdoc="<iframe id='inner' srcdoc='<button>Nested</button>'></iframe>"></iframe>
`;

describe('a node inside a hidden frame', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-hidden-frames-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'frames', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let page: Page;

  beforeAll(async () => {
    await engine.init!({ runId: 'frames', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    page = surfaceOf(engine)!.page();
    await page.setContent(DOCUMENT);
    await page.frameLocator('#outer').frameLocator('#inner').getByRole('button').waitFor({ state: 'attached' });
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reads as hidden when its frame, an ancestor of the frame, or an enclosing frame is hidden', async () => {
    for (const frames of [['#hidden'], ['#hidden-parent'], ['#outer', '#inner']]) {
      const matches = await engine.locate!(withinFrames(frames, BUTTON), operation);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.states?.hidden).toBe(true);
    }
  });

  it('reads as shown in a frame that shows itself again under a hidden ancestor', async () => {
    const matches = await engine.locate!(withinFrames(['#override'], BUTTON), operation);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.states?.hidden).toBeUndefined();
  });

  it('is no match of a visible or role query, indexed or not', async () => {
    const first: LocatorExpression = { kind: 'index', source: VISIBLE_BUTTON, index: 'first' };
    for (const expression of [VISIBLE_BUTTON, first, ROLE_BUTTON]) {
      expect(await engine.locate!(withinFrames(['#hidden'], expression), operation)).toEqual([]);
      expect(await engine.locate!(withinFrames(['#override'], expression), operation)).toHaveLength(1);
    }
  });

  it('reads as shown once the frame shows again', async () => {
    await page.locator('#hidden').evaluate((frame: HTMLElement) => { frame.style.visibility = 'visible'; });
    const matches = await engine.locate!(withinFrames(['#hidden'], BUTTON), operation);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.states?.hidden).toBeUndefined();
  });
});
