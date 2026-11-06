/** Focused typing validates the actual control inside open and recorded closed shadow roots. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
const typeText = (text: string, replace: boolean) => session.engine.keyboard!.type(text, { replace }, session.op(5_000));
const bodyData = (key: string) => session.browser.evaluate((name: string) => document.body.dataset[name] ?? null, key);
const page = { evaluate: <A,>(fn: (arg: A) => unknown, arg?: A) => session.browser.evaluate(fn as never, (arg ?? null) as never) };

beforeAll(async () => {
  session = await startWebSession();
});

beforeEach(async () => { await session.setContent('<body></body>'); });

afterAll(async () => {
  await session.close();
});

async function focusShadow(shadowMode: ShadowRootMode, markup: string): Promise<void> {
  await page.evaluate(({ mode, html }: { mode: ShadowRootMode; html: string }) => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.getElementById('inner')!.attachShadow({ mode });
    inner.innerHTML = html;
    const field = inner.querySelector<HTMLElement>('input,button,[tabindex]')!;
    field.focus();
    field.addEventListener('keydown', () => { document.body.dataset.keys = String(Number(document.body.dataset.keys ?? 0) + 1); });
    field.addEventListener('input', () => { document.body.dataset.value = (field as HTMLInputElement).value; });
    return null;
  }, { mode: shadowMode, html: markup });
}

describe.each(['open', 'closed'] as const)('%s shadow focus', (mode) => {
  it.each(['<button>Stop</button>', '<input readonly value="kept">'])('refuses a noneditable focused leaf: %s', async (html) => {
    await focusShadow(mode, html);
    await expect(typeText('lost', true)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await bodyData('keys')).toBeNull();
    expect(await bodyData('value')).toBeNull();
  });

  it('types into a nested editable leaf', async () => {
    await focusShadow(mode, '<input value="before">');
    await typeText('after', true);
    expect(await bodyData('value')).toBe('after');
  });

  it('retains focused custom widgets that opt into keystrokes', async () => {
    await focusShadow(mode, '<div tabindex="0">Custom widget</div>');
    await typeText('a', false);
    expect(await bodyData('keys')).toBe('1');
  });
});

it('does not mistake the iframe host for an editable control when its button has focus', async () => {
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise<void>((resolve) => { frame.addEventListener('load', () => resolve(), { once: true }); });
    frame.srcdoc = '<button id="stop">Stop</button>';
    document.body.append(frame);
    await loaded;
    frame.contentDocument!.getElementById('stop')!.focus();
    return null;
  });
  await expect(typeText('lost', false)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
});
