import { chromium, type Browser, type ElementHandle } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureDocument } from '../../src/observation.ts';

let browser: Browser;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

it.each(['stringify', 'bound-stringify', 'object-toJSON', 'array-toJSON', 'function-toString'] as const)('captures live refs when the page overrides %s', async (override) => {
  const page = await browser.newPage();
  const handles = new Map<string, ElementHandle<Element>>();
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
      commit: (id, element) => { handles.set(id, element); },
    }, page, { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal });

    expect(captured.nodeCount).toBe(3);
    expect(captured.truncated).toBe(false);
    const button = captured.tree.children?.[0];
    expect(button).toMatchObject({ role: 'button', name: 'Preserved "quoted" name' });
    expect(captured.tree.children?.[1]).toMatchObject({ states: { secure: true }, name: 'Password' });
    expect(JSON.stringify(captured.tree)).not.toContain('withheld-secret');
    await handles.get(button!.ref.id)!.click();
    expect(await page.getByRole('button').textContent()).toBe('Clicked');
  } finally {
    await Promise.all([...handles.values()].map((element) => element.dispose()));
    await page.close();
  }
});
