/**
 * A tap inside a frame a 3D transform turns lands on its target: the point
 * is carried through the quad the browser lays each turned frame out on,
 * nested turned frames composing, and inside a cross-origin frame.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { itFailsOnFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const TURN = 'transform: translate(60px, 40px) scale(1.2) rotate3d(1, 1, 1, 25deg)';
const FRAME_STYLE = `border: 4px solid black; padding: 3px; margin: 20px; width: 260px; height: 200px; ${TURN}`;
const TARGET = `<style>body { margin: 0 } button { margin: 30px 0 0 40px; width: 6px; height: 6px; padding: 0; border: 0 }</style><button aria-label="Target" onclick="this.setAttribute('aria-label', 'Clicked')"></button>`;

/** The target button, by its name. */
function button(name: string, frames: readonly string[]): LocatorExpression {
  const query: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: name, exact: true } } };
  return frames.reduceRight<LocatorExpression>((inner, selector) => ({ kind: 'frame', selector, source: inner }), query);
}

describe('taps in turned frames', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  /** Taps the target through `frames` and checks the click reached it. */
  async function tapThrough(frames: readonly string[]): Promise<void> {
    await page.waitForFrames();
    await page.act(button('Target', frames), { kind: 'tap' });
    expect(await page.locate(button('Clicked', frames))).toHaveLength(1);
  }

  it('taps through one frame rotated in 3D', async () => {
    await page.setContent(`<iframe id="outer" style="${FRAME_STYLE}" srcdoc="${attribute(TARGET)}"></iframe>`);
    await tapThrough(['#outer']);
  });

  it('taps through two nested turned frames', async () => {
    const inner = `<style>body { margin: 0 }</style><iframe id="inner" style="${FRAME_STYLE}" srcdoc="${attribute(TARGET)}"></iframe>`;
    await page.setContent(`<iframe id="outer" style="${FRAME_STYLE}; width: 400px; height: 360px" srcdoc="${attribute(inner)}"></iframe>`);
    await tapThrough(['#outer', '#inner']);
  });

  // Firefox bug: the tap lands outside the turned frame once a cross-origin frame holds it (NOT_ACTIONABLE, the click reached no event in the element's document).
  itFailsOnFirefox('taps through a turned frame inside a cross-origin frame', async () => {
    const target = page.serve('/turned-target', TARGET);
    const middle = page.serve('/turned-middle', `<style>body { margin: 0 }</style><iframe id="inner" style="${FRAME_STYLE}" src="${target}"></iframe>`);
    const crossOrigin = middle.replace('127.0.0.1', 'localhost');
    await page.setContent(`<iframe id="outer" style="border: 2px solid; margin: 15px 0 0 25px; width: 420px; height: 380px" src="${crossOrigin}"></iframe>`);
    await tapThrough(['#outer', '#inner']);
  });
});
