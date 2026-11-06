/**
 * CSS and XPath selectors on the BiDi driver match what Playwright 1.64.1
 * matches: each `>>` part is evaluated inside every element the part before
 * it matched, with CSS combinators stopping at that element and a leading
 * `/` in XPath read from it, CSS pierces open shadow roots, and a deep
 * descendant selector costs time linear in the DOM. The expected counts
 * were recorded from `page.locator(selector).count()` on Playwright 1.64.1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FrameRegistry, resolveFrames, selectElements } from '../../src/bidi/frames.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';

const SHADOW = `<p class="x"><div id="host"></div></p><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<section class="in"><span class="inner">S</span><button>Shadow</button></section>';</script>`;

/** Pages, and for each, selectors with the number of elements Playwright 1.64.1 matches. */
const CASES: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
  ['<main class="card"><article><button>X</button></article></main>', {
    'article >> main button': 0,
    'article >> .card > article > button': 0,
    'article >> article button': 0,
    'article >> button': 1,
    'main >> article button': 1,
    'main >> article > button': 1,
    'main >> main article': 0,
    'article >> :scope > button': 1,
  }],
  ['<ul><li class="a">1</li><li class="b">2</li></ul><ul><li class="c">3</li></ul>', {
    'ul >> li + li': 1,
    'li.a >> li': 0,
    'ul >> .a ~ .b': 1,
    'ul >> li ~ li': 1,
    'body >> ul + ul li': 1,
    'ul + ul >> li': 1,
  }],
  ['<section><button>In</button></section><button>Out</button>', {
    'css=section >> xpath=//button': 1,
    'section >> //button': 1,
    'section >> xpath=.//button': 1,
    'section >> xpath=/button': 1,
    'section >> (//button)': 2,
    'xpath=//section >> button': 1,
    '//button': 2,
    'section >> xpath=..': 1,
    'section >> xpath=//section': 0,
  }],
  [SHADOW, {
    'p .inner': 0,
    '#host span': 1,
    '#host >> span': 1,
    '#host >> section > span': 1,
    'div .in span, button': 2,
    '.in >> span': 1,
    'section ~ button': 0,
    'span ~ button': 1,
    '#host >> xpath=//span': 0,
    'span >> xpath=..': 1,
  }],
  ['<main><article><p><button>A</button></p><button>B</button></article></main>', {
    ':scope > body': 1,
    ':scope main': 1,
    'article >> :scope button': 2,
    'main >> :scope > article > button': 1,
    'article >> p > button, :scope > button': 2,
    'main >> article >> p button': 1,
    'xpath=//article >> xpath=./button': 1,
    'article >> xpath=//p >> button': 1,
    'article >> xpath=//button': 2,
  }],
  ['<div><div><div><span>x</span></div></div></div>', {
    'div >> div div span': 1,
    'div >> div > div > span': 1,
    'div div': 2,
    'div >> div': 2,
    'div >> div >> div': 1,
    'div div >> div span': 1,
  }],
];

describe.each(['chromium', 'firefox'] as const)('selectors as Playwright reads them on %s', (browser) => {
  let page: BidiPage;

  beforeAll(async () => {
    page = await openBidiPage({ browser });
  });

  afterAll(async () => {
    await page?.close();
  });

  /** How many elements `selector` matches on the driver. */
  const count = async (selector: string): Promise<number> => (await selectElements(page.connection, page.context, selector)).length;

  it.each(CASES.map(([html, expected], index) => [index, html, expected] as const))('matches page %i as Playwright does', async (_index, html, expected) => {
    await page.setContent(html);
    const actual: Record<string, number> = {};
    for (const selector of Object.keys(expected)) actual[selector] = await count(selector);
    expect(actual).toEqual(expected);
  });

  it('matches a deep descendant selector in time linear in the DOM', async () => {
    await page.setContent(`${'<div>'.repeat(24)}<span>x</span>${'</div>'.repeat(24)}`);
    const timed = async (selector: string): Promise<{ matches: number; ms: number }> => {
      const start = performance.now();
      const matches = await count(selector);
      return { matches, ms: performance.now() - start };
    };
    const missing = `section ${'div '.repeat(11)}span`;
    expect(await count(missing)).toBe(0);
    const runs = [await timed(missing), await timed(missing), await timed(missing)];
    expect(Math.min(...runs.map((run) => run.ms))).toBeLessThan(100);
    expect((await timed(`${'div '.repeat(12)}span`)).matches).toBe(1);
  });

  it('resolves a frame chain with one call per document', async () => {
    const inner = '<section><iframe srcdoc="<button>Deep</button>"></iframe></section>';
    await page.setContent(`<iframe id="outer" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`);
    const frames = new FrameRegistry();
    const context = await resolveFrames(page.connection, page.context, ['#outer', 'section >> xpath=//iframe'], frames);
    expect(frames.chain(context)).toHaveLength(2);
    expect((await selectElements(page.connection, context, 'button')).map((each) => each.localName)).toEqual(['button']);
  });
});
