/**
 * Adapted from microsoft/playwright tests/page/selectors-get-by.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: a string query is exact by default,
 * so Playwright's default substring match is `{ exact: false }` and its
 * `{ exact: true }` is the default; `evaluate(e => e.outerHTML)` reads become
 * text and attribute reads of the match.
 *
 * Not ported:
 * - getByTestId with custom testId should work: the test id attribute is project config, not per test.
 * - getByTestId with comma-separated testIdAttributes should match any: same.
 * - getByAltText should work: e2e has no getByAltText.
 * - getByTitle should work: e2e has no getByTitle.
 * - getByRole with description: e2e getByRole has no description option.
 * - getByRole with description via aria-describedby: same.
 * - getByRole with description via title fallback: same.
 * - getByRole with description whitespace normalization: same.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

test.describe('selectors get by', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('getByTestId should work', async ({ screen, browser }) => {
    await browser.goto(content('<div><div data-testid="Hello">Hello world</div></div>'));
    await expect(screen.getByTestId('Hello')).toHaveText('Hello world');
    await expect(browser.locator('div').getByTestId('Hello')).toHaveText('Hello world');
  });

  test('getByTestId should escape id', async ({ screen, browser }) => {
    await browser.goto(content(`<div><div data-testid='He"llo'>Hello world</div></div>`));
    await expect(screen.getByTestId('He"llo')).toHaveText('Hello world');
  });

  test('getByTestId should work for regex', async ({ screen, browser }) => {
    await browser.goto(content('<div><div data-testid="Hello">Hello world</div></div>'));
    await expect(screen.getByTestId(/He[l]*o/)).toHaveText('Hello world');
    await expect(browser.locator('div').getByTestId('Hello')).toHaveText('Hello world');
  });

  test('getByText should work', async ({ screen, browser }) => {
    await browser.goto(content(`<div>yo</div><div>ya</div><div>\nye  </div>`));
    expect(await screen.getByText('ye', { exact: false }).textContent()).toBe('ye');
    expect(await screen.getByText(/ye/).textContent()).toBe('ye');
    expect(await screen.getByText(/e/).textContent()).toBe('ye');

    await browser.goto(content(`<div> ye </div><div>ye</div>`));
    expect(await screen.getByText('ye').first().boundingBox()).toEqual(await browser.locator('div').first().boundingBox());

    await browser.goto(content(`<div>Hello world</div><div>Hello</div>`));
    expect(await screen.getByText('Hello').textContent()).toBe('Hello');
  });

  test('getByLabel should work', async ({ screen, browser }) => {
    await browser.goto(content(`<div><label for=target>Name</label><input id=target type=text></div>`));
    expect(await screen.getByText('Name', { exact: false }).getAttribute('for')).toBe('target');
    expect(await screen.getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
    expect(await browser.locator('div').getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should work with nested elements', async ({ screen, browser }) => {
    await browser.goto(content(`<label for=target>Last <span>Name</span></label><input id=target type=text>`));

    await expect(screen.getByLabel('last name', { exact: false })).toHaveAttribute('id', 'target');
    await expect(screen.getByLabel('st na', { exact: false })).toHaveAttribute('id', 'target');
    await expect(screen.getByLabel('Name', { exact: false })).toHaveAttribute('id', 'target');
    await expect(screen.getByLabel('Last Name')).toHaveAttribute('id', 'target');
    await expect(screen.getByLabel(/Last\s+name/i)).toHaveAttribute('id', 'target');

    expect(await screen.getByLabel('Last').count()).toBe(0);
    expect(await screen.getByLabel('last name').count()).toBe(0);
    expect(await screen.getByLabel('Name').count()).toBe(0);
    expect(await screen.getByLabel('what?', { exact: false }).count()).toBe(0);
    expect(await screen.getByLabel(/last name/).count()).toBe(0);
  });

  test('getByLabel should work with multiply-labelled input', async ({ screen, browser }) => {
    await browser.goto(content(`<label for=target>Name</label><input id=target type=text><label for=target>First or Last</label>`));
    expect(await screen.getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
    expect(await screen.getByLabel('First or Last', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should work with ancestor label and multiple controls', async ({ screen, browser }) => {
    await browser.goto(content(`<label>Name<button id=target>Click me</button><input type=text></label>`));
    expect(await screen.getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should work with ancestor label and for', async ({ screen, browser }) => {
    await browser.goto(content(`
      <label for=target>Name<input type=text id=nontarget></label>
      <input type=text id=target>
    `));
    expect(await screen.getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should work with aria-labelledby', async ({ screen, browser }) => {
    await browser.goto(content(`<label id=name-label>Name</label><button aria-labelledby=name-label>Click me</button>`));
    expect(await screen.getByLabel('Name', { exact: false }).textContent()).toBe('Click me');
  });

  test('getByLabel should prioritize aria-labelledby over native label', async ({ screen, browser }) => {
    await browser.goto(content(`
      <label id=name-label>Name</label>
      <label>Wrong<button aria-labelledby=name-label>Click me</button></label>
    `));
    expect(await screen.getByLabel('Name', { exact: false }).textContent()).toBe('Click me');
  });

  test('getByLabel should work with aria-label', async ({ screen, browser }) => {
    await browser.goto(content(`<input id=target aria-label="Name">`));
    expect(await screen.getByLabel('Name', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should ignore empty aria-label', async ({ screen, browser }) => {
    await browser.goto(content(`<label for=target>Last Name</label><input id=target type=text aria-label>`));
    expect(await screen.getByLabel('Last Name', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByLabel should prioritize aria-labelledby over aria-label', async ({ screen, browser }) => {
    await browser.goto(content(`<label id=other-label>Other</label><input id=target aria-label="Name" aria-labelledby=other-label>`));
    expect(await screen.getByLabel('Other', { exact: false }).getAttribute('id')).toBe('target');
  });

  test('getByPlaceholder should work', async ({ screen, browser }) => {
    await browser.goto(content(`<div>
      <input placeholder='Hello'>
      <input placeholder='Hello World'>
    </div>`));
    await expect(screen.getByPlaceholder('hello', { exact: false })).toHaveCount(2);
    await expect(screen.getByPlaceholder('Hello')).toHaveCount(1);
    await expect(screen.getByPlaceholder(/wor/i)).toHaveCount(1);

    await expect(browser.locator('div').getByPlaceholder('hello', { exact: false })).toHaveCount(2);
  });

  test('getBy escaping', async ({ screen, browser }) => {
    const setAttributes = "(value) => { const input = document.querySelector('input'); for (const name of ['placeholder', 'title', 'alt']) input.setAttribute(name, value); }";

    await browser.goto(content(`<label id=label for=control>Hello my
wo"rld</label><input id=control />`));
    await browser.evaluate(setAttributes, 'hello my\nwo"rld');
    await expect.soft(screen.getByText('hello my\nwo"rld', { exact: false })).toHaveAttribute('id', 'label');
    await expect.soft(screen.getByText('hello       my     wo"rld', { exact: false })).toHaveAttribute('id', 'label');
    await expect.soft(screen.getByLabel('hello my\nwo"rld', { exact: false })).toHaveAttribute('id', 'control');
    await expect.soft(screen.getByPlaceholder('hello my\nwo"rld', { exact: false })).toHaveAttribute('id', 'control');

    await browser.goto(content(`<label id=label for=control>Hello my
world</label><input id=control />`));
    await browser.evaluate(setAttributes, 'hello my\nworld');
    await expect.soft(screen.getByText('hello my\nworld', { exact: false })).toHaveAttribute('id', 'label');
    await expect.soft(screen.getByText('hello        my    world', { exact: false })).toHaveAttribute('id', 'label');
    await expect.soft(screen.getByLabel('hello my\nworld', { exact: false })).toHaveAttribute('id', 'control');
    await expect.soft(screen.getByPlaceholder('hello my\nworld', { exact: false })).toHaveAttribute('id', 'control');

    await browser.goto(content(`<label for=target>foo &gt;&gt; bar</label><input id=target>`));
    await browser.evaluate(setAttributes, 'foo >> bar');
    expect.soft(await screen.getByText('foo >> bar', { exact: false }).textContent()).toBe('foo >> bar');
    await expect.soft(browser.locator('label')).toHaveText('foo >> bar');
    await expect.soft(screen.getByText('foo >> bar', { exact: false })).toHaveText('foo >> bar');
    expect.soft(await screen.getByText(/foo >> bar/).textContent()).toBe('foo >> bar');
    await expect.soft(screen.getByLabel('foo >> bar', { exact: false })).toHaveAttribute('id', 'target');
    await expect.soft(screen.getByLabel(/foo >> bar/)).toHaveAttribute('id', 'target');
    await expect.soft(screen.getByPlaceholder('foo >> bar', { exact: false })).toHaveAttribute('id', 'target');
    await expect.soft(screen.getByPlaceholder(/foo >> bar/)).toHaveAttribute('id', 'target');
  });

  test('getByRole escaping', async ({ screen, browser }) => {
    await browser.goto(content(`
      <a href="https://playwright.dev">issues 123</a>
      <a href="https://playwright.dev">he llo 56</a>
      <button>Click me</button>
    `));
    expect.soft(await screen.getByRole('button').allTextContents()).toEqual(['Click me']);
    expect.soft(await screen.getByRole('link').allTextContents()).toEqual(['issues 123', 'he llo 56']);

    expect.soft(await screen.getByRole('link', { name: 'issues 123', exact: false }).allTextContents()).toEqual(['issues 123']);
    expect.soft(await screen.getByRole('link', { name: 'sues', exact: false }).allTextContents()).toEqual(['issues 123']);
    expect.soft(await screen.getByRole('link', { name: '  he    \n  llo ', exact: false }).allTextContents()).toEqual(['he llo 56']);
    expect.soft(await screen.getByRole('button', { name: 'issues', exact: false }).allTextContents()).toEqual([]);

    expect.soft(await screen.getByRole('link', { name: 'sues' }).allTextContents()).toEqual([]);
    expect.soft(await screen.getByRole('link', { name: '   he \n llo 56 ' }).allTextContents()).toEqual(['he llo 56']);

    expect.soft(await screen.getByRole('button', { name: 'Click me' }).allTextContents()).toEqual(['Click me']);
    expect.soft(await screen.getByRole('button', { name: 'Click \\me' }).allTextContents()).toEqual([]);
    expect.soft(await screen.getByRole('button', { name: 'Click \\\\me' }).allTextContents()).toEqual([]);
  });

  test('getByRole should accept regexp with v flag', async ({ screen, browser }) => {
    await browser.goto(content(`<button>Click me</button><button>Submit</button>`));
    await expect(screen.getByRole('button', { name: new RegExp('Click me', 'v') })).toHaveCount(1);
    await expect(screen.getByRole('button', { name: new RegExp('click me', 'iv') })).toHaveCount(1);
    await expect(screen.getByRole('button', { name: new RegExp('Missing', 'v') })).toHaveCount(0, { timeout: 1000 });
  });

  test('locators should not be affected by global and sticky regex flags', async ({ screen, browser }) => {
    await browser.goto(content(`
      <div>foo</div><div>foo</div><div>foo</div>
      <label>foo<input></label><label>foo<input></label><label>foo<input></label>
      <button>foo</button><button>foo</button><button>foo</button>
      <input placeholder=foo><input placeholder=foo><input placeholder=foo>
    `));
    await expect(screen.getByText(/foo/)).toHaveCount(9);
    await expect(screen.getByText(/foo/g)).toHaveCount(9);
    await expect(screen.getByText(/foo/y)).toHaveCount(9);
    await expect(screen.getByLabel(/foo/)).toHaveCount(3);
    await expect(screen.getByLabel(/foo/g)).toHaveCount(3);
    await expect(screen.getByLabel(/foo/y)).toHaveCount(3);
    await expect(screen.getByRole('button', { name: /foo/ })).toHaveCount(3);
    await expect(screen.getByRole('button', { name: /foo/g })).toHaveCount(3);
    await expect(screen.getByRole('button', { name: /foo/y })).toHaveCount(3);
    await expect(screen.getByPlaceholder(/foo/)).toHaveCount(3);
    await expect(screen.getByPlaceholder(/foo/g)).toHaveCount(3);
    await expect(screen.getByPlaceholder(/foo/y)).toHaveCount(3);
  });
});
