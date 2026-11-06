/**
 * A `frameLocator` chain resolves each frame inside the one before it: the
 * inner selector is looked up in the outer frame's document, never in the
 * page, as a browser's own frame chain does. A
 * located node's box is in the top-level viewport, as the contract asks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
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
  `<h2>Outer</h2><iframe id="inner" title="inner" style="border:7px solid;padding:5px" srcdoc="${attribute(INNER_DOCUMENT)}"></iframe>` +
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
  let page: WebSession;
  const locate = (expression: LocatorExpression) => page.locate(expression);
  /** Reads `read` of the inner frame's document, through both frames. */
  const innerDocument = <T,>(read: string) => page.browser.evaluate(
    `() => { const doc = document.querySelector('#outer').contentDocument.querySelector('#inner').contentDocument; return (${read})(doc); }`,
  ) as Promise<T>;

  beforeAll(async () => {
    page = await startWebSession();
    await page.setContent(HOST_DOCUMENT);
    await page.browser.evaluate(async () => {
      const deep = () => document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument
        ?.querySelector<HTMLIFrameElement>('#inner')?.contentDocument
        ?.querySelector<HTMLIFrameElement>('#deep')?.contentDocument?.querySelector('button');
      while (deep() == null) await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    });
  });

  afterAll(async () => {
    await page.close();
  });

  it('resolves a two-level chain and taps inside the innermost frame', async () => {
    const matches = await locate(withinFrames(['#outer', '#inner'], INNER_BUTTON));
    expect(matches.map((node) => node.name)).toEqual(['Inner button']);
    await page.engine.perform!(matches[0]!.ref, { kind: 'tap' }, page.op());
    expect(await innerDocument<string>("(doc) => doc.querySelector('button').innerText")).toBe('Inner clicked');
  });

  it('reports a located node\'s box in the top-level viewport, past each frame\'s border and padding', async () => {
    // The inner document's one button, whatever an earlier test renamed it to.
    const button: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } };
    const [node] = await locate(withinFrames(['#outer', '#inner'], button));
    // The same element's box, measured through both frames' borders and padding.
    const expected = (await page.browser.evaluate(() => {
      let x = 0;
      let y = 0;
      let doc = document;
      for (const selector of ['#outer', '#inner']) {
        const frame = doc.querySelector<HTMLIFrameElement>(selector)!;
        const style = getComputedStyle(frame);
        const box = frame.getBoundingClientRect();
        x += box.x + frame.clientLeft + Number.parseFloat(style.paddingLeft);
        y += box.y + frame.clientTop + Number.parseFloat(style.paddingTop);
        doc = frame.contentDocument!;
      }
      const button = doc.querySelector('button')!.getBoundingClientRect();
      return { x: x + button.x, y: y + button.y, width: button.width, height: button.height };
    }))!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node!.rect![key]).toBeCloseTo(expected[key], 3);
  });

  it('resolves a three-level chain, counting the last frame inside the second', async () => {
    const matches = await locate(withinFrames(['#outer', '#inner', '#deep'], DEEP_BUTTON));
    expect(matches.map((node) => node.name)).toEqual(['Deep button']);
    await expect(locate(withinFrames(['#outer', '#deep'], DEEP_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #deep',
    });
  });

  it('names the inner selector when the outer frame holds no such frame, even though the page does', async () => {
    await expect(locate(withinFrames(['#outer', '#aside'], INNER_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #aside',
      retryable: true,
    });
  });

  it('reports two matching frames inside the outer document as ambiguous, though the page holds one', async () => {
    expect(await page.browser.evaluate(() => document.querySelectorAll('.twin').length)).toBe(1);
    await expect(locate(withinFrames(['#outer', '.twin'], INNER_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_AMBIGUOUS',
      message: '2 frames match .twin',
      retryable: false,
    });
  });
});
