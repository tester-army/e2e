/**
 * A node inside a hidden frame reads as hidden: the frame element's own
 * `hidden` state, read in the document around it, counts for every node in
 * its document and in the frames nested under it. A `visible` or role query
 * there matches nothing, under an index too, as neither matches a hidden node.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

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
  let page: WebSession;
  const locate = (expression: LocatorExpression) => page.locate(expression);

  beforeAll(async () => {
    page = await startWebSession();
    await page.setContent(DOCUMENT);
    await page.browser.evaluate(async () => {
      const nested = () => document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument
        ?.querySelector<HTMLIFrameElement>('#inner')?.contentDocument?.querySelector('button');
      while (nested() == null) await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    });
    await page.waitForFrames();
  });

  afterAll(async () => {
    await page.close();
  });

  // Missing in BiDi: a node inside a hidden frame does not read as hidden.
  it('reads as hidden when its frame, an ancestor of the frame, or an enclosing frame is hidden', async () => {
    for (const frames of [['#hidden'], ['#hidden-parent'], ['#outer', '#inner']]) {
      const matches = await locate(withinFrames(frames, BUTTON));
      expect(matches).toHaveLength(1);
      expect(matches[0]!.states?.hidden).toBe(true);
    }
  });

  it('reads as shown in a frame that shows itself again under a hidden ancestor', async () => {
    const matches = await locate(withinFrames(['#override'], BUTTON));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.states?.hidden).toBeUndefined();
  });

  // Missing in BiDi: a visible or role query still matches inside a hidden frame.
  it('is no match of a visible or role query, indexed or not', async () => {
    const first: LocatorExpression = { kind: 'index', source: VISIBLE_BUTTON, index: 'first' };
    for (const expression of [VISIBLE_BUTTON, first, ROLE_BUTTON]) {
      expect(await locate(withinFrames(['#hidden'], expression))).toEqual([]);
      expect(await locate(withinFrames(['#override'], expression))).toHaveLength(1);
    }
  });

  it('reads as shown once the frame shows again', async () => {
    await page.browser.evaluate(() => {
      document.querySelector<HTMLElement>('#hidden')!.style.visibility = 'visible';
      return null;
    });
    const matches = await locate(withinFrames(['#hidden'], BUTTON));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.states?.hidden).toBeUndefined();
  });
});
