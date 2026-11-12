/** An observed node's element is made from the in-page array, so a document replaced since the walk must read as a stale node. */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ElementList } from '../../src/element-list.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
  await page.setContent('<button id="go">Go</button>');
});

/** The array the reader would leave behind: every element of the walk, in document order. */
async function listOf(): Promise<ElementList> {
  return new ElementList(await page.evaluateHandle(() => [...document.querySelectorAll('button')]));
}

describe('ElementList on a real page', () => {
  it('makes a handle for the element the walk read', async () => {
    const list = await listOf();
    const element = await list.at(0);
    expect(await element.evaluate((node) => node.id)).toBe('go');
    list.dispose();
  });

  it('reports a navigation since the walk as a retryable stale node', async () => {
    const list = await listOf();
    await page.goto('about:blank');
    await expect(list.at(0)).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    list.dispose();
  });

  it('reports an index the walk never listed as a retryable stale node', async () => {
    const list = await listOf();
    await expect(list.at(5)).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    list.dispose();
  });
});
