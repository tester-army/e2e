/**
 * Locator parity with Playwright 1.64.1, differentially: each case of
 * `PARITY_PAGES` must match the elements Playwright matched on the same
 * page, in its order, on Chromium and on Firefox. A scale guard keeps
 * locating over thousands of rows linear.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import type { BrowserName } from '../../src/browser-names.ts';
import { PARITY_PAGES } from '../helpers/locator-parity.ts';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe.each<BrowserName>(['chromium', 'firefox'])('locators match as Playwright does on %s', (browser) => {
  let session: WebSession;

  beforeAll(async () => {
    session = await startWebSession({ web: { browser } });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  /** The `id` of each element `expression` locates, in order. */
  async function ids(expression: LocatorExpression): Promise<string[]> {
    return (await session.locate(expression)).map((node) => node.attributes?.['id'] ?? '');
  }

  for (const page of PARITY_PAGES) {
    it(`on the ${page.name} page`, async () => {
      await session.setContent(page.html);
      const actual = [];
      for (const each of page.cases) actual.push({ locator: each.playwright, ids: await ids(each.expression) });
      expect(actual).toEqual(page.cases.map((each) => ({ locator: each.playwright, ids: each.expected })));
    });
  }

  it('locates over 3000 rows in linear time', async () => {
    const rows = Array.from({ length: 3000 }, (_, index) => `<li><span>row ${index}</span><button>Edit ${index}</button></li>`).join('');
    await session.setContent(`<ul>${rows}</ul>`);
    const started = performance.now();
    expect(await session.locate({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'row', exact: false } } })).toHaveLength(3000);
    expect(await session.locate({ kind: 'filter', source: byRole('listitem'), hasText: { kind: 'string', value: 'row 2910', exact: false } })).toHaveLength(1);
    expect(await session.locate({ kind: 'filter', source: byRole('listitem'), has: byRole('button', 'Edit 2910') })).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
