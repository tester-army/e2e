/** A node an observation published stays actionable through later observations of the same document. */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

it('keeps the latest observation\'s refs actionable after repeated captures', async () => {
  await page.setContent('<button onclick="this.textContent = \'Clicked\'">Click me</button>');
  let buttonRef;
  for (let index = 0; index < 3; index += 1) {
    const { root } = await page.observe();
    expect(root.children).toHaveLength(1);
    buttonRef = root.children?.find((node) => node.role === 'button')?.ref;
  }
  expect(buttonRef).toBeDefined();
  await page.engine.perform!(buttonRef!, { kind: 'tap' }, page.op());
  expect(await page.browser.evaluate(() => document.querySelector('button')!.textContent)).toBe('Clicked');
});
