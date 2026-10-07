/**
 * `check` and `uncheck` against a real page, through both kinds of target the
 * engine acts on: a deterministic locator and an element handle from an agent
 * observation. A control the app replaces or navigates away from once it is
 * picked took the click, so the action is done; a control the click never
 * reached stays a stale node, and one the click did not change fails.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction } from 'e2e/engine';
import { classifyActionError, dispatchLocatorAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

let browser: Browser;
let page: Page;
let server: Server;
let origin: string;

beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/'
        ? '<label><input type="radio" name="plan" id="pro" onchange="location.href = \'/next\'">Pro</label>'
        : '<p>Next page</p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
});

const KINDS = ['locator', 'element'] as const;

/** The control as the engine would hold it: a locator, or an element handle pinned by an observation. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<ActionTarget> {
  const locator = page.locator(selector);
  if (kind === 'locator') return { kind, locator };
  const element = await locator.elementHandle();
  if (element === null) throw new Error(`no element for ${selector}`);
  return { kind, element };
}

/** Performs one action and returns the contract error it failed with, classified as the engine reports it. */
async function perform(target: ActionTarget, action: LocatorAction): Promise<Error | undefined> {
  try {
    await dispatchLocatorAction(target, action, 2000, () => {
      throw new Error('no second target');
    });
    return undefined;
  } catch (cause) {
    return classifyActionError(cause, action);
  }
}

/** Clicks the page saw, counted in the page. */
function clicks(): Promise<number> {
  return page.evaluate(() => (window as unknown as { clicks: number }).clicks);
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('through the %s target', (kind) => {
  it('checks a radio the app replaces with its selected view', async () => {
    await page.setContent(`
      <div id="plan"><label><input type="radio" name="plan" id="pro"
        onchange="document.getElementById('plan').innerHTML = '<p>Pro selected</p>'">Pro</label></div>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'check' })).toBeUndefined();
    expect(await page.textContent('#plan')).toBe('Pro selected');
  });

  it('leaves what replaced the control to the next read, even an unchecked copy', async () => {
    await page.setContent(`
      <div id="terms"><label><input type="checkbox" id="box"
        onchange="document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'">Agree</label></div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#box')).toBe(false);
  });

  it('checks a radio that navigates on change', async () => {
    await page.goto(`${origin}/`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'check' })).toBeUndefined();
    await page.waitForURL(`${origin}/next`);
  });

  it('checks and unchecks a checkbox, and clicks nothing already in the wanted state', async () => {
    await page.setContent(`${COUNT_CLICKS}<label><input type="checkbox" id="box">Notify</label>`);
    const target = await targetOf(kind, '#box');
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#box')).toBe(true);
    expect(await perform(target, { kind: 'uncheck' })).toBeUndefined();
    expect(await page.isChecked('#box')).toBe(false);
    expect(await clicks()).toBe(2);
  });

  it('checks an ARIA checkbox', async () => {
    await page.setContent(`
      <div role="checkbox" id="box" aria-checked="false" tabindex="0"
        onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">Notify</div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await page.getAttribute('#box', 'aria-checked')).toBe('true');
  });

  it('fails a click that left the control as it was, as one the app may have acted on', async () => {
    await page.setContent('<label><input type="checkbox" id="box" onclick="event.preventDefault()">Locked</label>');
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'ACTION_MAY_HAVE_COMMITTED',
      message: 'check clicked the control but its checked state did not change',
    });
  });

  it('refuses to uncheck a radio without clicking it', async () => {
    await page.setContent(`${COUNT_CLICKS}<label><input type="radio" name="plan" id="pro" checked>Pro</label>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'uncheck' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await clicks()).toBe(0);
  });

  it('refuses a control that cannot be checked', async () => {
    await page.setContent('<button id="go">Go</button>');
    expect(await perform(await targetOf(kind, '#go'), { kind: 'check' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });
});

describe('a control gone before the click', () => {
  it('stays a retryable stale node: nothing was dispatched', async () => {
    await page.setContent('<label><input type="checkbox" id="box">Notify</label>');
    const target = await targetOf('element', '#box');
    await page.evaluate(() => document.getElementById('box')!.remove());
    expect(await perform(target, { kind: 'check' })).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});
