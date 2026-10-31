/**
 * `check` and `uncheck` against a real page, through both kinds of target the
 * engine acts on: a deterministic locator and an element handle from an agent
 * observation. A control the app replaces or navigates away from once it is
 * picked took the click, so the action is done; a control the click never
 * reached stays a stale node, one that commits its state after a timer is
 * waited for, and one the click never changes fails at the deadline.
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

/** A refusal waits out the whole deadline, so the cases that expect one take a short one. */
const REFUSAL_TIMEOUT_MS = 500;

/** Performs one action and returns the contract error it failed with, classified as the engine reports it. */
async function perform(target: ActionTarget, action: LocatorAction, timeoutMs = 2000): Promise<Error | undefined> {
  try {
    await dispatchLocatorAction(target, action, { timeoutMs, signal: new AbortController().signal }, () => {
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

const ELEMENT_PLUS_CSS = `
.el-radio-button{outline:none;display:inline-block;position:relative}
.el-radio-button__original-radio{opacity:0;z-index:-1;outline:none;position:absolute}
.el-radio-button__inner{white-space:nowrap;vertical-align:middle;background:#fff;border:1px solid #dcdfe6;line-height:1;cursor:pointer;display:inline-block;position:relative;padding:8px 15px}
.el-checkbox{cursor:pointer;display:inline-flex;align-items:center;position:relative}
.el-checkbox__input{white-space:nowrap;cursor:pointer;outline:none;display:inline-flex;position:relative}
.el-checkbox__original{opacity:0;z-index:-1;outline:none;width:0;height:0;margin:0;position:absolute}
.el-checkbox__inner{display:inline-block;position:relative;border:1px solid #dcdfe6;width:14px;height:14px;background:#fff;z-index:1}
.el-radio{cursor:pointer;display:inline-flex;align-items:center;position:relative}
.el-radio__input{white-space:nowrap;cursor:pointer;outline:none;display:inline-flex;position:relative}
.el-radio__original{opacity:0;z-index:-1;outline:none;margin:0;position:absolute;top:0;bottom:0;left:0;right:0}
.el-radio__inner{border:1px solid #dcdfe6;border-radius:100%;width:14px;height:14px;background:#fff;position:relative;display:inline-block}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10}
`;

const ELEMENT_PLUS_CONTROLS = `
<label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="install"><span class="el-radio-button__inner">安装</span></label>
<label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="remove"><span class="el-radio-button__inner">卸载</span></label>
<label class="el-checkbox"><span class="el-checkbox__input"><input class="el-checkbox__original" type="checkbox" id="agree"><span class="el-checkbox__inner"></span></span><span class="el-checkbox__label">Agree</span></label>
<label class="el-radio"><span class="el-radio__input"><input class="el-radio__original" type="radio" name="size" id="large"><span class="el-radio__inner"></span></span><span class="el-radio__label">Large</span></label>
`;

const ELEMENT_PLUS_PAGE = `<style>${ELEMENT_PLUS_CSS}</style>${ELEMENT_PLUS_CONTROLS}`;

const ELEMENT_PLUS_CASES = [
  ['radio-button', '#install'],
  ['checkbox', '#agree'],
  ['radio', '#large'],
] as const;

describe.each(KINDS)('a control its own label covers, through the %s target', (kind) => {
  it.each(ELEMENT_PLUS_CASES)('checks an Element Plus %s', async (_, selector) => {
    await page.setContent(ELEMENT_PLUS_PAGE);
    expect(await perform(await targetOf(kind, selector), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked(selector)).toBe(true);
  });

  it.each(ELEMENT_PLUS_CASES)('taps an Element Plus %s', async (_, selector) => {
    await page.setContent(ELEMENT_PLUS_PAGE);
    expect(await perform(await targetOf(kind, selector), { kind: 'tap' })).toBeUndefined();
    expect(await page.isChecked(selector)).toBe(true);
  });

  it.each(ELEMENT_PLUS_CASES)('still refuses an Element Plus %s under a modal', async (_, selector) => {
    await page.setContent(`${ELEMENT_PLUS_PAGE}<div class="modal"></div>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, selector), action, REFUSAL_TIMEOUT_MS)).toMatchObject({ code: 'NOT_ACTIONABLE' });
      expect(await page.isChecked(selector)).toBe(false);
    }
  });

  it.each(ELEMENT_PLUS_CASES)('waits out a loading mask over an Element Plus %s', async (_, selector) => {
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      await page.setContent(`${ELEMENT_PLUS_PAGE}<div class="modal"></div>
        <script>setTimeout(() => document.querySelector('.modal').remove(), 300)</script>`);
      expect(await perform(await targetOf(kind, selector), action)).toBeUndefined();
      expect(await page.isChecked(selector)).toBe(true);
    }
  });

  it.each(ELEMENT_PLUS_CASES)('waits for an Element Plus %s in a dialog that opens later', async (_, selector) => {
    for (const display of ['display:none', 'visibility:hidden']) {
      for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
        await page.setContent(`<style>${ELEMENT_PLUS_CSS}</style><div id="dialog" style="${display}">${ELEMENT_PLUS_CONTROLS}</div>
          <script>setTimeout(() => document.getElementById('dialog').removeAttribute('style'), 300)</script>`);
        expect(await perform(await targetOf(kind, selector), action)).toBeUndefined();
        expect(await page.isChecked(selector)).toBe(true);
      }
    }
  });

  it('still refuses a radio whose label covers it from outside the label box', async () => {
    await page.setContent(`
      <label style="display:inline-block;width:60px;height:20px">Pick<input type="radio" id="r"
        style="position:absolute;left:200px;top:100px;opacity:0;z-index:-1"><span
        style="position:absolute;left:190px;top:90px;width:40px;height:40px;background:#fff"></span></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#r'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('intercepts pointer events'),
      });
      expect(await page.isChecked('#r')).toBe(false);
    }
  });

  it('checks a boxless checkbox through its first visible label, past a hidden one', async () => {
    await page.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:none">A</label>
      <label for="c">B</label>`);
    expect(await perform(await targetOf(kind, '#c'), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#c')).toBe(true);
  });

  it('checks a boxless checkbox past a label hidden by visibility, which keeps its box', async () => {
    await page.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="visibility:hidden">A</label>
      <label for="c">B</label>`);
    expect(await perform(await targetOf(kind, '#c'), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#c')).toBe(true);
  });

  it('still refuses a radio under a link in its own label, and follows no link', async () => {
    await page.setContent(`<style>${ELEMENT_PLUS_CSS}</style>
      <label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="install">
        <a href="#went" class="el-radio-button__inner">安装</a></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('intercepts pointer events'),
      });
      expect(await page.isChecked('#install')).toBe(false);
      expect(page.url()).not.toContain('#went');
    }
  });

  it('still refuses a boxless checkbox whose visible label has a link at its centre', async () => {
    await page.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:inline-block"><a href="#went">Terms</a></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#c'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('not visible'),
      });
      expect(await page.isChecked('#c')).toBe(false);
      expect(page.url()).not.toContain('#went');
    }
  });

  it('still refuses an Element Plus radio-button a disabled fieldset holds', async () => {
    await page.setContent(`<style>${ELEMENT_PLUS_CSS}</style><fieldset disabled>${ELEMENT_PLUS_CONTROLS}</fieldset>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('not enabled'),
      });
      expect(await page.isChecked('#install')).toBe(false);
    }
  });

  it('still refuses a boxless checkbox whose every label is hidden', async () => {
    await page.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:none">A</label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#c'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: `${action.kind} did not become actionable in time: the control and its labels are not visible`,
      });
      expect(await page.isChecked('#c')).toBe(false);
    }
  });

  it('still refuses a disabled Element Plus radio-button', async () => {
    await page.setContent(ELEMENT_PLUS_PAGE.replace('id="install"', 'id="install" disabled'));
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({ code: 'NOT_ACTIONABLE' });
      expect(await page.isChecked('#install')).toBe(false);
    }
  });

  it('checks an Element Plus radio-button inside a shadow root', async () => {
    await page.setContent(`<div id="host"></div><script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(ELEMENT_PLUS_PAGE)};
    </script>`);
    expect(await perform(await targetOf(kind, '#install'), { kind: 'check' })).toBeUndefined();
    expect(await page.isChecked('#install')).toBe(true);
  });
});

describe('a tap on a locator that never appears', () => {
  it('fails NOT_ACTIONABLE within one deadline, as a plain click does', async () => {
    await page.setContent('<p>Nothing to tap</p>');
    const started = Date.now();
    const error = await perform({ kind: 'locator', locator: page.locator('#missing') }, { kind: 'tap' });
    expect(Date.now() - started).toBeLessThan(3500);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(error?.message).toMatch(/^tap did not become actionable in time: .*Timeout 2000ms exceeded/);
    expect(error?.message).toContain("waiting for locator('#missing')");
  });
});

describe('a control its own label covers, inside a frame', () => {
  it('checks an Element Plus radio-button', async () => {
    await page.setContent(`<p>Outer</p><iframe srcdoc="${ELEMENT_PLUS_PAGE.replaceAll('"', '&quot;')}"></iframe>`);
    const locator = page.frameLocator('iframe').locator('#install');
    expect(await perform({ kind: 'locator', locator }, { kind: 'check' })).toBeUndefined();
    expect(await locator.isChecked()).toBe(true);
  });
});

describe('an action cancelled while its stand-in read is in flight', () => {
  it.each(KINDS)('clicks nothing through the %s target', async (kind) => {
    for (const [selector, action] of [['#install', { kind: 'tap' }], ['#install', { kind: 'check' }], ['#plain', { kind: 'tap' }]] as const) {
      await page.setContent(`${ELEMENT_PLUS_PAGE}<input type="checkbox" id="plain">`);
      const target = await targetOf(kind, selector);
      // Holds the page's main thread, so the read waits behind it until after the abort.
      await page.evaluate(() => setTimeout(() => { const until = Date.now() + 400; while (Date.now() < until); }, 0));
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(
        dispatchLocatorAction(target, action, { timeoutMs: 2000, signal: controller.signal }, () => {
          throw new Error('no second target');
        }),
      ).rejects.toThrow('cancelled');
      expect(await page.isChecked(selector)).toBe(false);
    }
  });
});
