/**
 * CSS selectors written with `CSS.escape()` match on the BiDi driver what
 * the browser's own `querySelectorAll` matches: an escaped combinator,
 * comma, space, or leading digit stays inside its compound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectElements } from '../../src/driver/frames.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';

const IDS = ['a>b', 'a+b', 'a~b', 'a b', 'a,b', 'a:b', 'a[b]', 'a(b)', 'a"b', "a'b", 'a\\b', 'a>>b', 'a\tb', '123', '1 2', '-1x'];

let page: BidiPage;

beforeAll(async () => {
  page = await openBidiPage();
  await page.setContent('<main id="root"></main>');
  await page.evaluate((ids: string[]) => {
    const root = document.getElementById('root')!;
    for (const id of ids) {
      const box = document.createElement('div');
      box.id = id;
      box.className = id;
      box.innerHTML = '<span>child</span><b>next</b>';
      root.append(box);
    }
    const host = document.createElement('section');
    host.id = 'host x';
    host.attachShadow({ mode: 'open' }).innerHTML = '<p class="p>q">inside</p>';
    root.append(host);
  }, IDS);
});

afterAll(async () => {
  await page?.close();
});

/** The selector each id escapes to with `CSS.escape()`, read in the page. */
async function escaped(id: string): Promise<string> {
  return (await page.evaluate((value: string) => CSS.escape(value), id)) as string;
}

/** The light-DOM path of each element `selector` matches on the driver. */
async function driverMatches(selector: string): Promise<string[]> {
  const found = await selectElements(page.connection, page.context, selector);
  const refs = found.map((each) => each.element);
  return (await page.evaluate((...elements: Element[]) => elements.map((element) => `${element.localName}#${element.id || element.parentElement?.id || (element.getRootNode() as ShadowRoot).host?.id}`), ...refs)) as string[];
}

/** The same paths for what the browser's `querySelectorAll` matches. */
async function nativeMatches(selector: string): Promise<string[]> {
  return (await page.evaluate(
    (value: string) => [...document.querySelectorAll(value)].map((element) => `${element.localName}#${element.id || element.parentElement?.id || (element.getRootNode() as ShadowRoot).host?.id}`),
    selector,
  )) as string[];
}

describe('CSS escapes on the BiDi driver', () => {
  it.each(IDS)('matches the id %j as querySelectorAll does', async (id) => {
    const selector = `#${await escaped(id)}`;
    const native = await nativeMatches(selector);
    expect(native).toHaveLength(1);
    expect(await driverMatches(selector)).toEqual(native);
  });

  it.each(IDS)('matches compounds around the class %j as querySelectorAll does', async (id) => {
    const name = await escaped(id);
    for (const selector of [`.${name} > span`, `.${name} span + b`, `div.${name} ~ div.${name}`, `main .${name}, #root > .${name} b`, `#root>.${name}>b`]) {
      expect(await driverMatches(selector), selector).toEqual(await nativeMatches(selector));
    }
  });

  it('reads a hex escape and its terminating space as one leading digit', async () => {
    for (const selector of ['#\\31 23', '#\\31 23 > span', '#\\000031 23', '#\\31\t23 b', '#\\31 \\ 2']) {
      const native = await nativeMatches(selector);
      expect(native.length, selector).toBeGreaterThan(0);
      expect(await driverMatches(selector), selector).toEqual(native);
    }
  });

  it('keeps an escaped >> inside its chain part', async () => {
    const selector = `#${await escaped('a>>b')} >> span`;
    expect(await driverMatches(selector)).toEqual(['span#a>>b']);
  });

  it('still pierces open shadow roots with escaped compounds', async () => {
    expect(await driverMatches('#host\\ x .p\\>q')).toEqual(['p#host x']);
    expect(await nativeMatches('#host\\ x .p\\>q')).toEqual([]);
  });
});
