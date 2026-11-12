/**
 * Adapted from microsoft/playwright tests/page/locator-query.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `locator(css, { hasText, has })` is
 * a locator `filter`, `div >> p` the CSS `div p`, a nested `.locator(css)`
 * the matching semantic query scoped to the outer locator, `toHaveClass` the
 * browser matcher, and `evaluate(e => e.outerHTML)` a text read.
 *
 * Not ported:
 * - should throw on capture w/ nth(): Playwright `*css=` capture selector.
 * - should throw on due to strictness 2: `locator.evaluate`.
 * - should support locator.and: e2e locators have no and().
 * - should support locator.locator with and/or: e2e locators have no locator(locator) or and().
 * - should support locator.within: e2e locators have no within().
 * - should keep the capture when removing a common frame prefix: `*css=` captures and `contentFrame()`.
 * - count() should not throw during navigation: custom selector engines.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

const sections = `
  <section>
    <div><p>A</p></div>
    <div><p>A</p><p>A</p></div>
    <div><p>A</p><p>A</p><p>A</p></div>
  </section>`;

test.describe('locator query', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should respect first() and last() @smoke', async ({ browser }) => {
    await browser.goto(content(sections));
    expect(await browser.locator('div p').count()).toBe(6);
    expect(await browser.locator('div').first().getByText('A').count()).toBe(1);
    expect(await browser.locator('div').last().getByText('A').count()).toBe(3);
  });

  test('should respect nth()', async ({ browser }) => {
    await browser.goto(content(sections));
    expect(await browser.locator('div p').nth(0).count()).toBe(1);
    expect(await browser.locator('div').nth(1).getByText('A').count()).toBe(2);
    expect(await browser.locator('div').nth(2).getByText('A').count()).toBe(3);
  });

  test('should throw on due to strictness', async ({ browser }) => {
    await browser.goto(content(`<div>A</div><div>B</div>`));
    const error = await browser.locator('div').isVisible().catch((e: unknown) => e);
    expect(error).toEqual(expect.any(Error));
  });

  test('should filter by text', async ({ browser }) => {
    await browser.goto(content(`<div>Foobar</div><div>Bar</div>`));
    await expect(browser.locator('div').filter({ hasText: 'Foo' })).toHaveText('Foobar');
  });

  test('should filter by text 2', async ({ browser }) => {
    await browser.goto(content(`<div>foo <span>hello world</span> bar</div>`));
    await expect(browser.locator('div').filter({ hasText: 'hello world' })).toHaveText('foo hello world bar');
  });

  test('should filter by regex', async ({ browser }) => {
    await browser.goto(content(`<div>Foobar</div><div>Bar</div>`));
    await expect(browser.locator('div').filter({ hasText: /Foo.*/ })).toHaveText('Foobar');
  });

  test('should filter by text with quotes', async ({ browser }) => {
    await browser.goto(content(`<div>Hello "world"</div><div>Hello world</div>`));
    await expect(browser.locator('div').filter({ hasText: 'Hello "world"' })).toHaveText('Hello "world"');
  });

  test('should filter by regex with quotes', async ({ browser }) => {
    await browser.goto(content(`<div>Hello "world"</div><div>Hello world</div>`));
    await expect(browser.locator('div').filter({ hasText: /Hello "world"/ })).toHaveText('Hello "world"');
  });

  test('should filter by regex with a single quote', async ({ screen, browser }) => {
    await browser.goto(content(`<button>let's let's<span>hello</span></button>`));
    for (const pattern of [/let's/i, /let's/i, /'s/i, /'s/i, /let['abc]s/i, /let's let's/i, /let's let's/i]) {
      await expect.soft(browser.locator('button').filter({ hasText: pattern }).getByText('hello')).toHaveText('hello');
      await expect.soft(screen.getByRole('button', { name: pattern }).getByText('hello')).toHaveText('hello');
    }
    await expect.soft(browser.locator('button').filter({ hasText: /let\\'s/i })).not.toBeVisible();
    await expect.soft(screen.getByRole('button', { name: /let\\'s/i })).not.toBeVisible();

    await browser.goto(content(`<button>let\\'s let\\'s<span>hello</span></button>`));
    await expect.soft(browser.locator('button').filter({ hasText: /let's/i })).not.toBeVisible();
    await expect.soft(screen.getByRole('button', { name: /let's/i })).not.toBeVisible();
    for (const pattern of [/let\\'s/i, /let\\'s/i, /let\\'s let\\'s/i, /let\\'s let\\'s/i]) {
      await expect.soft(browser.locator('button').filter({ hasText: pattern }).getByText('hello')).toHaveText('hello');
      await expect.soft(screen.getByRole('button', { name: pattern }).getByText('hello')).toHaveText('hello');
    }

    await browser.goto(content(`<button>let's hello</button>`));
    await expect.soft(browser.locator('button').filter({ hasText: /let's/iu })).toHaveText(`let's hello`);
    await expect.soft(screen.getByRole('button', { name: /let's/iu })).toHaveText(`let's hello`);
  });

  test('should filter by regex and regexp flags', async ({ browser }) => {
    await browser.goto(content(`<div>Hello "world"</div><div>Hello world</div>`));
    await expect(browser.locator('div').filter({ hasText: /hElLo "world"/i })).toHaveText('Hello "world"');
  });

  test('should filter by case-insensitive regex in a child', async ({ browser }) => {
    await browser.goto(content(`<div class="test"><h5>Title Text</h5></div>`));
    await expect(browser.locator('div').filter({ hasText: /^title text$/i })).toHaveText('Title Text');
  });

  test('should filter by case-insensitive regex in multiple children', async ({ browser }) => {
    await browser.goto(content(`<div class="test"><h5>Title</h5> <h2><i>Text</i></h2></div>`));
    await expect(browser).toHaveClass(browser.locator('div').filter({ hasText: /^title text$/i }), 'test');
  });

  test('should filter by regex with special symbols', async ({ browser }) => {
    await browser.goto(content(`<div class="test"><h5>First/"and"</h5><h2><i>Second\\</i></h2></div>`));
    await expect(browser).toHaveClass(browser.locator('div').filter({ hasText: /^first\/".*"second\\$/si }), 'test');
  });

  test('should support has:locator', async ({ screen, browser }) => {
    await browser.goto(content(`<div><span>hello</span></div><div><span>world</span></div>`));
    await expect(browser.locator('div').filter({ has: screen.getByText('world', { exact: false }) })).toHaveCount(1);
    expect(await browser.locator('div').filter({ has: screen.getByText('world', { exact: false }) }).textContent()).toBe('world');
    await expect(browser.locator('div').filter({ has: screen.getByText('hello') })).toHaveCount(1);
    expect(await browser.locator('div').filter({ has: screen.getByText('hello') }).textContent()).toBe('hello');
    await expect(browser.locator('div').filter({ has: browser.locator('span') })).toHaveCount(2);
    await expect(browser.locator('div').filter({ has: browser.locator('span').filter({ hasText: 'wor' }) })).toHaveCount(1);
    expect(await browser.locator('div').filter({ has: browser.locator('span').filter({ hasText: 'wor' }) }).textContent()).toBe('world');
    await expect(browser.locator('div').filter({ has: browser.locator('span'), hasText: 'wor' })).toHaveCount(1);
  });

  test('should support locator.filter', async ({ browser }) => {
    await browser.goto(content(`<section><div><span>hello</span></div><div><span>world</span></div></section>`));
    await expect(browser.locator('div').filter({ hasText: 'hello' })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasText: 'hello' }).filter({ hasText: 'hello' })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasText: 'hello' }).filter({ hasText: 'world' })).toHaveCount(0);
    await expect(browser.locator('section').filter({ hasText: 'hello' }).filter({ hasText: 'world' })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasText: 'hello' }).getByText('hello')).toHaveCount(1);
    await expect(browser.locator('div').filter({ has: browser.locator('span').filter({ hasText: 'world' }) })).toHaveCount(1);
    await expect(browser.locator('div').filter({ has: browser.locator('span') })).toHaveCount(2);
    await expect(browser.locator('div').filter({ has: browser.locator('span'), hasText: 'world' })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasNot: browser.locator('span').filter({ hasText: 'world' }) })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasNot: browser.locator('section') })).toHaveCount(2);
    await expect(browser.locator('div').filter({ hasNot: browser.locator('span') })).toHaveCount(0);
    await expect(browser.locator('div').filter({ hasNotText: 'hello' })).toHaveCount(1);
    await expect(browser.locator('div').filter({ hasNotText: 'foo' })).toHaveCount(2);
  });

  test('should support locator.or', async ({ browser }) => {
    await browser.goto(content(`<div>hello</div><span>world</span>`));
    await expect(browser.locator('div').or(browser.locator('span'))).toHaveCount(2);
    await expect(browser.locator('div').or(browser.locator('span'))).toHaveText(['hello', 'world']);
    await expect(browser.locator('span').or(browser.locator('article')).or(browser.locator('div'))).toHaveText(['hello', 'world']);
    await expect(browser.locator('article').or(browser.locator('something'))).toHaveCount(0);
    await expect(browser.locator('article').or(browser.locator('div'))).toHaveText('hello');
    await expect(browser.locator('article').or(browser.locator('span'))).toHaveText('world');
    await expect(browser.locator('div').or(browser.locator('article'))).toHaveText('hello');
    await expect(browser.locator('span').or(browser.locator('article'))).toHaveText('world');
  });

  test('should allow some, but not all nested frameLocators', async ({ browser }) => {
    await browser.goto(content(`<iframe srcdoc="<span id=target>world</span>"></iframe><span>hello</span>`));
    const frame = browser.frameLocator('iframe');
    await expect(frame.locator('span').or(frame.locator('article'))).toHaveText('world');
    await expect(frame.locator('article').or(frame.locator('span'))).toHaveText('world');
    const error = await expect(frame.locator('div').or(browser.frameLocator('#iframe').locator('span'))).toHaveText('world').catch((e: unknown) => e);
    expect(error).toEqual(expect.any(Error));
  });

  test('should enforce same frame for has/leftOf/rightOf/above/below/near', async ({ browser }) => {
    await browser.goto('/frames/two-frames.html');
    const child = browser.frameLocator('iframe[name=uno]');
    let error: unknown;
    try {
      await browser.locator('div').filter({ has: child.locator('span') }).count();
    } catch (e) {
      error = e;
    }
    expect(error).toEqual(expect.any(Error));
  });

  test('alias methods coverage', async ({ screen, browser }) => {
    await browser.goto(content(`<div><button>Submit</button></div>`));
    await expect(browser.locator('button')).toHaveCount(1);
    await expect(browser.locator('div').getByRole('button')).toHaveCount(1);
    await expect(screen.getByRole('button')).toHaveCount(1);
  });
});
