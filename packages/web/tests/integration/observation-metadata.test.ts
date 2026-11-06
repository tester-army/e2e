import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureDocument } from '../../src/observation.ts';
import { Published } from '../helpers/published.ts';

let browser: Browser;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

it.each(['stringify', 'bound-stringify', 'object-toJSON', 'array-toJSON', 'function-toString'] as const)('captures live refs when the page overrides %s', async (override) => {
  const page = await browser.newPage();
  const published = new Published();
  try {
    await page.setContent(`<button onclick="this.textContent = 'Clicked'">Preserved "quoted" name</button>
      <input type="password" aria-label="Password" value="withheld-secret">`);
    await page.evaluate((kind) => {
      if (kind === 'stringify') JSON.stringify = () => '{"nodes":[],"ids":[],"truncated":false}';
      else if (kind === 'bound-stringify') {
        // oxlint-disable-next-line no-extra-bind -- Bound replacements stringify like anonymous native functions.
        JSON.stringify = (() => 'not JSON').bind(null);
      } else if (kind === 'function-toString') {
        // oxlint-disable-next-line no-extend-native -- Serializer detection must survive application overrides too.
        Function.prototype.toString = () => { throw new Error('disabled'); };
      } else {
        // oxlint-disable-next-line no-extend-native -- The fixture reproduces application prototype overrides.
        Object.defineProperty(kind === 'object-toJSON' ? Object.prototype : Array.prototype, 'toJSON', {
          value: () => 'not metadata', configurable: true,
        });
      }
    }, override);
    const captured = await captureDocument({
      testIdAttribute: 'data-testid', site: undefined, reserveIds: () => 1,
      commit: published.commit,
    }, page, { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal });

    expect(captured.nodeCount).toBe(3);
    expect(captured.truncated).toBe(false);
    const button = captured.tree.children?.[0];
    expect(button).toMatchObject({ role: 'button', name: 'Preserved "quoted" name' });
    expect(captured.tree.children?.[1]).toMatchObject({ states: { secure: true }, name: 'Password' });
    expect(JSON.stringify(captured.tree)).not.toContain('withheld-secret');
    await (await published.element(button!.ref.id)).click();
    expect(await page.getByRole('button').textContent()).toBe('Clicked');
  } finally {
    published.dispose();
    await page.close();
  }
});
