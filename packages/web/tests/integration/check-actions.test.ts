/**
 * `check` and `uncheck` against a real page, for both callers the engine acts
 * for: a test's deterministic step and the agent acting on what it observed. A control the app replaces or navigates away from once it is
 * picked took the click, so the action is done; a control the click never
 * reached stays a stale node, one that commits its state after a timer is
 * waited for, and one the click never changes fails at the deadline.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction, NodeRef } from 'e2e/engine';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
let origin: string;

beforeAll(async () => {
  session = await startWebSession({ startAttempt: false });
  origin = session.origin;
  session.serve('/', '<label><input type="radio" name="plan" id="pro" onchange="location.href = \'/next\'">Pro</label>');
  session.serve('/next', '<p>Next page</p>');
});

afterAll(async () => {
  await session.close();
});

beforeEach(async () => {
  await session.startAttempt();
});

const KINDS = ['test', 'agent'] as const;

/** The caller an action runs for and the node it acts on. */
interface Target {
  readonly origin: (typeof KINDS)[number];
  readonly ref: NodeRef;
}

/** The one node `selector` locates, acted on for `origin`. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<Target> {
  const [node, ...rest] = await session.locate(bySelector(selector));
  if (node === undefined || rest.length > 0) throw new Error(`expected one node for ${selector}`);
  return { origin: kind, ref: node.ref };
}

/** Performs one action and returns the contract error it failed with, as the engine reports it. */
async function perform(target: Target, action: LocatorAction): Promise<Error | undefined> {
  try {
    await session.engine.perform!(target.ref, action, { ...session.op(2_000), origin: target.origin });
    return undefined;
  } catch (cause) {
    return cause as Error;
  }
}

/** The page, read through the fixture. */
const page = {
  setContent: (html: string) => session.setContent(html),
  goto: (url: string) => session.open(url),
  evaluate: <T,>(fn: () => T) => session.browser.evaluate(fn as never) as Promise<T>,
  textContent: (selector: string) => session.browser.evaluate((target: string) => document.querySelector(target)?.textContent ?? null, selector),
  isChecked: (selector: string) => session.browser.evaluate((target: string) => document.querySelector<HTMLInputElement>(target)!.checked, selector),
  getAttribute: (selector: string, name: string) => session.browser.evaluate(
    ({ target, attribute }: { target: string; attribute: string }) => document.querySelector(target)!.getAttribute(attribute),
    { target: selector, attribute: name },
  ),
  waitForURL: async (url: string) => {
    const deadline = Date.now() + 5_000;
    while (await session.browser.url() !== url) {
      if (Date.now() > deadline) throw new Error(`never reached ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
};

/** Clicks the page saw, counted in the page. */
function clicks(): Promise<number> {
  return page.evaluate(() => (window as unknown as { clicks: number }).clicks);
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('for the %s', (kind) => {
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

  it('waits for a controlled checkbox that commits its state after a timer', async () => {
    await page.setContent(`
      <label><input type="checkbox" id="box"
        onclick="const box = this; const next = box.checked; event.preventDefault();
          setTimeout(() => { box.checked = next; }, 300)">Notify</label>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#box')).toBe(true);
  });

  it('waits for a switch whose aria-checked flips after a timer', async () => {
    await page.setContent(`
      <button role="switch" id="toggle" aria-checked="true"
        onclick="setTimeout(() => this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true')), 300)">Wi-Fi</button>`);
    expect(await perform(await targetOf(kind, '#toggle'), { kind: 'uncheck' })).toBeUndefined();
    expect(await page.getAttribute('#toggle', 'aria-checked')).toBe('false');
  });

  it('fails a rejected click on a control a later re-render replaces', async () => {
    await page.setContent(`
      <div id="terms"><label><input type="checkbox" id="box" onclick="event.preventDefault();
        setTimeout(() => { document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'; }, 300)">Agree</label></div>`);
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change before the control was replaced',
    });
  });

  it('fails a click that left the control as it was', async () => {
    await page.setContent('<label><input type="checkbox" id="box" onclick="event.preventDefault()">Locked</label>');
    expect(await perform(await targetOf(kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change',
    });
  });

  it('refuses to uncheck a radio without clicking it', async () => {
    await page.setContent(`${COUNT_CLICKS}<label><input type="radio" name="plan" id="pro" checked>Pro</label>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'uncheck' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await clicks()).toBe(0);
  });

  it('unchecks an ARIA radio by clicking it, leaving the radio behavior to its script', async () => {
    await page.setContent(`
      <div role="radio" id="pro" aria-checked="true" tabindex="0"
        onclick="this.setAttribute('aria-checked', 'false')">Pro</div>`);
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'uncheck' })).toBeUndefined();
    expect(await page.getAttribute('#pro', 'aria-checked')).toBe('false');
  });

  it('fails an ARIA radio whose click keeps it checked, naming the radio group', async () => {
    await page.setContent('<div role="radio" id="pro" aria-checked="true" tabindex="0">Pro</div>');
    expect(await perform(await targetOf(kind, '#pro'), { kind: 'uncheck' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: expect.stringContaining('another radio in its group'),
    });
  });

  it('refuses a control that cannot be checked', async () => {
    await page.setContent('<button id="go">Go</button>');
    expect(await perform(await targetOf(kind, '#go'), { kind: 'check' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });
});

describe('a control gone before the click', () => {
  it('stays a retryable stale node: nothing was dispatched', async () => {
    await page.setContent('<label><input type="checkbox" id="box">Notify</label>');
    const target = await targetOf('agent', '#box');
    await page.evaluate(() => { document.getElementById('box')!.remove(); return null; });
    expect(await perform(target, { kind: 'check' })).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});
