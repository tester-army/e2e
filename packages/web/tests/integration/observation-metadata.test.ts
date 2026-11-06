import { afterAll, beforeAll, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => { page = await startWebSession(); });
afterAll(async () => { await page.close(); });

type Override = 'stringify' | 'bound-stringify' | 'object-toJSON' | 'array-toJSON' | 'function-toString';

/** Overrides one page global the reader's metadata could go through, then observes and taps through the published ref. */
async function capturesLiveRefs(override: Override): Promise<void> {
  await page.setContent(`<button onclick="this.textContent = 'Clicked'">Preserved "quoted" name</button>
    <input type="password" aria-label="Password" value="withheld-secret">`);
  const readClicked = () => page.browser.evaluate(() => document.querySelector('button')!.textContent);
  await page.browser.evaluate((kind: string) => {
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
    return null;
  }, override);
  const snapshot = await page.observe();

  expect(snapshot.truncated).toBeUndefined();
  expect(snapshot.root.children).toHaveLength(2);
  const button = snapshot.root.children?.[0];
  expect(button).toMatchObject({ role: 'button', name: 'Preserved "quoted" name' });
  expect(snapshot.root.children?.[1]).toMatchObject({ states: { secure: true }, name: 'Password' });
  expect(JSON.stringify(snapshot.root)).not.toContain('withheld-secret');
  await page.engine.perform!(button!.ref, { kind: 'tap' }, page.op());
  expect(await readClicked()).toBe('Clicked');
}

it.each(['stringify', 'bound-stringify', 'object-toJSON', 'array-toJSON'] as const)('captures live refs when the page overrides %s', capturesLiveRefs);

// Missing in BiDi: an observation fails once the page overrides Function.prototype.toString.
it.skip('captures live refs when the page overrides function-toString', () => capturesLiveRefs('function-toString'));
