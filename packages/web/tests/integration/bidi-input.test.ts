/**
 * Input on both BiDi browsers, as a page sees it: a key held across a
 * Shift change gets its keyup, Shift shifts a key named by its character,
 * a swipe leaves the mouse on what it scrolled, a drag carries pressure and
 * reaches a target in a rotated frame, a pointer target outside the
 * viewport is refused as never sent, and a ref reused after input checks
 * its locator again. Firefox runs when it is installed
 * (`npx @e2e-dev/web install firefox`).
 */

import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { ROOT_NODE_ID } from '../../src/driver/observe.ts';
import { browserExecutable } from '../../src/install/provision.ts';

/** Whether the pinned Firefox is installed. */
async function firefoxInstalled(): Promise<boolean> {
  try {
    return existsSync(await browserExecutable('firefox', false));
  } catch {
    return false;
  }
}

const browsers = (await firefoxInstalled()) ? (['chromium', 'firefox'] as const) : (['chromium'] as const);

/** Escapes HTML for a single-quoted attribute value, so a document can carry a `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

describe.each(browsers)('input on %s', (browser) => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ web: { browser }, timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  /** The events the page logged into `window.log`. */
  const log = (): Promise<unknown> => page.browser.evaluate('window.log');

  it('releases a key held across a Shift change with the key it pressed', async () => {
    await page.setContent(`<input id=i><script>
      window.log = [];
      for (const type of ['keydown', 'keyup']) addEventListener(type, (event) => log.push(type + ':' + event.key), true);
    </script>`);
    await page.browser.evaluate('document.getElementById("i").focus()');
    const { keyboard } = page.browser;
    await keyboard.down('Shift');
    await keyboard.down('a');
    await keyboard.up('Shift');
    await keyboard.up('a');
    await keyboard.press('b');
    expect(await log()).toEqual(['keydown:Shift', 'keydown:A', 'keyup:Shift', 'keyup:A', 'keydown:b', 'keyup:b']);
  });

  it('shifts a key named by its character, through the fixture and the contract alike', async () => {
    await page.setContent('<input id=i><input id=j>');
    await page.browser.evaluate('document.getElementById("i").focus()');
    for (const key of ['Shift+a', 'Shift+1', 'Shift+Digit2']) await page.browser.keyboard.press(key);
    await page.browser.evaluate('document.getElementById("j").focus()');
    for (const key of ['Shift+a', 'Shift+1']) await page.engine.keyboard!.press(key, page.op());
    expect(await page.browser.evaluate('[document.getElementById("i").value, document.getElementById("j").value]')).toEqual(['A!@', 'A!']);
  });

  it('leaves the mouse on what a swipe scrolled, so a viewport swipe scrolls it again', async () => {
    await page.setContent(`<div style="height:3000px;padding-top:150px">
      <div id=s onmouseenter="window.entered = true" style="margin-left:200px;width:300px;height:200px;overflow:auto"><div style="height:5000px">inner</div></div>
    </div>`);
    await page.act(bySelector('#s'), { kind: 'swipe', direction: 'down' });
    const first = await page.browser.evaluate('({ inner: document.getElementById("s").scrollTop, entered: window.entered === true })') as { inner: number; entered: boolean };
    expect(first.entered).toBe(true);
    expect(first.inner).toBeGreaterThan(0);
    await page.engine.perform!({ id: ROOT_NODE_ID } as never, { kind: 'swipe', direction: 'down' }, page.op());
    expect(await page.browser.evaluate('[document.getElementById("s").scrollTop > ' + String(first.inner) + ', scrollY]')).toEqual([true, 0]);
  });

  it('presses every move of a pointer drag with a held button\'s pressure', async () => {
    await page.setContent(`<div style="width:600px;height:400px"></div><script>
      window.log = [];
      addEventListener('pointermove', (event) => { if (event.buttons) log.push(event.pressure); }, true);
    </script>`);
    await page.engine.performAt!({ x: 50, y: 50 }, { kind: 'dragTo', target: { x: 300, y: 200 } }, page.op());
    expect(await log()).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('drags onto a target in a rotated frame, resolving the target once the source is pressed', async () => {
    const inner = '<div id=dst style="width:120px;height:120px;background:blue" onmouseup="parent.ups = (parent.ups || 0) + 1">drop</div>';
    await page.setContent(`<div id=src style="width:60px;height:60px;background:red">drag</div>
      <iframe id=f style="transform:rotate(15deg);margin:40px;width:300px;height:200px" srcdoc='${attribute(inner)}'></iframe>`);
    await page.waitForFrames();
    const target: LocatorExpression = { kind: 'frame', selector: '#f', source: bySelector('#dst') };
    const [dst] = await page.locate(target);
    await page.act(bySelector('#src'), { kind: 'dragTo', target: dst!.ref });
    expect(await page.browser.evaluate('window.ups ?? 0')).toBe(1);
  });

  it('refuses a pointer target outside the viewport before sending anything, and takes its far edge', async () => {
    await page.setContent('<button style="width:200px;height:100px" onmouseleave="window.left = true">hover me</button>');
    await page.browser.mouse.move(50, 50);
    await expect(page.browser.mouse.move(-1, -1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('outside the 1280x720 viewport') });
    await expect(page.engine.performAt!({ x: 1283, y: 10 }, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await page.browser.evaluate('window.left ?? false')).toBe(false);
    await page.engine.performAt!({ x: 1280, y: 720 }, { kind: 'hover' }, page.op());
    expect(await page.browser.evaluate('window.left ?? false')).toBe(true);
  });

  it('checks a ref reused after input still names its locator\'s only match', async () => {
    await page.setContent('<button id=a onclick="document.body.append(Object.assign(document.createElement(\'button\'), { className: \'twin\', textContent: \'twin\' }))" class=twin>twin</button>');
    const [twin] = await page.locate(bySelector('.twin'));
    await page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op());
    await expect(page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', message: expect.stringContaining('now matches 2 elements') });
  });
});
