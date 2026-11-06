/**
 * Adapted from microsoft/playwright tests/page/page-fill.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.fill(selector, value)` is a locator fill.
 */

/*
 * Not ported:
 * - should throw if passed a non-string value: asserts Playwright's protocol validator message for a number; `fill` is typed to strings.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

/** Five pairs of animation frames, Playwright's `rafraf(page, 5)`, so a pending fill has had its chance. */
const giveItAChanceToFill = '() => new Promise((resolve) => { let frames = 0; const step = () => (++frames === 10 ? setTimeout(resolve, 0) : requestAnimationFrame(step)); requestAnimationFrame(step); })';

test.describe('page fill', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should fill textarea', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').fill('some value');
    expect(await browser.evaluate('result')).toBe('some value');
  });

  test('should fill input', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('input').fill('some value');
    expect(await browser.evaluate('result')).toBe('some value');
  });

  test('should throw on unsupported inputs', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    for (const type of ['button', 'checkbox', 'file', 'image', 'radio', 'reset', 'submit']) {
      await browser.evaluate("(type) => document.querySelector('input').setAttribute('type', type)", type);
      const error = await browser.locator('input').fill('').catch((caught: Error) => caught);
      expect((error as Error).message).toContain(`Input of type "${type}" cannot be filled`);
    }
  });

  test('should fill different input types', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    for (const type of ['password', 'search', 'tel', 'text', 'url', 'invalid-type']) {
      await browser.evaluate("(type) => document.querySelector('input').setAttribute('type', type)", type);
      await browser.locator('input').fill('text ' + type);
      expect(await browser.evaluate('result')).toBe('text ' + type);
    }
  });

  test('should fill range input', async ({ browser }) => {
    await browser.goto(content('<input type=range min=0 max=100 value=50>'));
    await browser.locator('input').fill('42');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('42');
  });

  test('should throw on incorrect range value', async ({ browser }) => {
    await browser.goto(content('<input type=range min=0 max=100 value=50>'));
    const error1 = await browser.locator('input').fill('foo').catch((caught: Error) => caught);
    expect((error1 as Error).message).toContain('Malformed value');
    const error2 = await browser.locator('input').fill('200').catch((caught: Error) => caught);
    expect((error2 as Error).message).toContain('Malformed value');
    const error3 = await browser.locator('input').fill('15.43').catch((caught: Error) => caught);
    expect((error3 as Error).message).toContain('Malformed value');
  });

  test('should fill color input', async ({ browser }) => {
    await browser.goto(content('<input type=color value="#e66465">'));
    await browser.locator('input').fill('#aaaaaa');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('#aaaaaa');
  });

  test('should fill color input case insensitive', async ({ browser }) => {
    await browser.goto(content('<input type=color value="#e66465">'));
    await browser.locator('input').fill('#AbCd00');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('#abcd00');
  });

  test('should throw on incorrect color value', async ({ browser }) => {
    await browser.goto(content('<input type=color value="#e66465">'));
    const error1 = await browser.locator('input').fill('badvalue').catch((caught: Error) => caught);
    expect((error1 as Error).message).toContain('Malformed value');
  });

  test('should fill date input after clicking', async ({ browser }) => {
    await browser.goto(content('<input type=date>'));
    await browser.locator('input').tap();
    await browser.locator('input').fill('2020-03-02');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('2020-03-02');
  });

  for (const [type, value] of Object.entries({
    'color': '#aaaaaa',
    'date': '2020-03-02',
    'time': '13:15',
    'datetime-local': '2020-03-02T13:15:30',
    'month': '2020-03',
    'range': '42',
    'week': '2020-W50',
  })) {
    test(`input event.composed should be true and cross shadow dom boundary - ${type}`, async ({ browser }) => {
      await browser.goto('/empty.html');
      await browser.goto(content(`<body><script>
      const div = document.createElement('div');
      const shadowRoot = div.attachShadow({mode: 'open'});
      shadowRoot.innerHTML = '<input type=${type}></input>';
      document.body.appendChild(div);
    </script></body>`));
      await browser.evaluate(`() => {
        window.firedBodyEvents = [];
        for (const event of ['input', 'change'])
          document.body.addEventListener(event, (e) => window.firedBodyEvents.push(e.type + ':' + e.composed), false);
      }`);
      await browser.evaluate(`() => {
        window.firedEvents = [];
        const input = document.querySelector('div').shadowRoot.querySelector('input');
        for (const event of ['input', 'change'])
          input.addEventListener(event, (e) => window.firedEvents.push(e.type + ':' + e.composed), false);
      }`);
      await browser.locator('input').fill(value);
      expect(await browser.evaluate('firedEvents')).toEqual(['input:true', 'change:false']);
      expect(await browser.evaluate('firedBodyEvents')).toEqual(['input:true']);
    });
  }

  test('should throw on incorrect date', async ({ browser }) => {
    await browser.goto(content('<input type=date>'));
    const error = await browser.locator('input').fill('2020-13-05').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Malformed value');
  });

  test('should fill time input', async ({ browser }) => {
    await browser.goto(content('<input type=time>'));
    await browser.locator('input').fill('13:15');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('13:15');
  });

  test('should fill month input', async ({ browser }) => {
    await browser.goto(content('<input type=month>'));
    await browser.locator('input').fill('2020-07');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('2020-07');
  });

  test('should throw on incorrect month', async ({ browser }) => {
    await browser.goto(content('<input type=month>'));
    const error = await browser.locator('input').fill('2020-13').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Malformed value');
  });

  test('should fill week input', async ({ browser }) => {
    await browser.goto(content('<input type=week>'));
    await browser.locator('input').fill('2020-W50');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('2020-W50');
  });

  test('should throw on incorrect week', async ({ browser }) => {
    await browser.goto(content('<input type=week>'));
    const error = await browser.locator('input').fill('2020-123').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Malformed value');
  });

  test('should throw on incorrect time', async ({ browser }) => {
    await browser.goto(content('<input type=time>'));
    const error = await browser.locator('input').fill('25:05').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Malformed value');
  });

  test('should fill datetime-local input', async ({ browser }) => {
    await browser.goto(content('<input type=datetime-local>'));
    await browser.locator('input').fill('2020-03-02T05:15');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('2020-03-02T05:15');
  });

  test('should throw on incorrect datetime-local', async ({ browser }) => {
    await browser.goto(content('<input type=datetime-local>'));
    const error = await browser.locator('input').fill('abc').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Malformed value');
  });

  test('should fill contenteditable', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('div[contenteditable]').fill('some value');
    expect(await browser.evaluate("() => document.querySelector('div[contenteditable]').textContent")).toBe('some value');
  });

  test('should fill contenteditable with new lines', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(content('<div contenteditable="true"></div>'));
    await browser.locator('div[contenteditable]').fill('John\nDoe');
    expect(await browser.evaluate("() => document.querySelector('div[contenteditable]').innerText")).toBe('John\nDoe');
  });

  test('should not double-fill in contenteditable with beforeinput handler in Firefox', async ({ browser }) => {
    await browser.goto(content(`
      <div id="editor" contenteditable="true"></div>
      <script>
        const editor = document.getElementById('editor');
        editor.addEventListener('beforeinput', (event) => {
          event.preventDefault();
          editor.textContent = event.data;
        });
      </script>
    `));
    const locator = browser.locator('#editor');
    const testValue = 'Playwright';
    await locator.fill(testValue);
    await expect(locator).toHaveText(testValue);
  });

  test('should fill elements with existing value and selection', async ({ browser }) => {
    await browser.goto('/input/textarea.html');

    await browser.evaluate("() => { document.querySelector('input').value = 'value one'; }");
    await browser.locator('input').fill('another value');
    expect(await browser.evaluate('result')).toBe('another value');

    await browser.evaluate("() => { const input = document.querySelector('input'); input.selectionStart = 1; input.selectionEnd = 2; }");
    await browser.locator('input').fill('maybe this one');
    expect(await browser.evaluate('result')).toBe('maybe this one');

    await browser.evaluate(`() => {
      const div = document.querySelector('div[contenteditable]');
      div.innerHTML = 'some text <span>some more text<span> and even more text';
      const range = document.createRange();
      range.selectNodeContents(div.querySelector('span'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }`);
    await browser.locator('div[contenteditable]').fill('replace with this');
    expect(await browser.evaluate("() => document.querySelector('div[contenteditable]').textContent")).toBe('replace with this');
  });

  test('should throw nice error without injected script stack when element is not an <input>', async ({ browser }) => {
    await browser.goto(content('<select><option>value1</option></select>'));
    const error = await browser.locator('select').fill('').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Element is not an <input>, <textarea> or [contenteditable] element');
  });

  test('should retry on disabled element', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.evaluate("() => { document.querySelector('input').disabled = true; }");
    let done = false;
    const promise = browser.locator('input').fill('some value', { timeout: 10_000 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToFill);
    expect(done).toBe(false);
    expect(await browser.evaluate('result')).toBe('');

    await browser.evaluate("() => { document.querySelector('input').disabled = false; }");
    await promise;
    expect(await browser.evaluate('result')).toBe('some value');
  });

  test('should retry on readonly element', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.evaluate("() => { document.querySelector('textarea').readOnly = true; }");
    let done = false;
    const promise = browser.locator('textarea').fill('some value', { timeout: 10_000 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToFill);
    expect(done).toBe(false);
    expect(await browser.evaluate('result')).toBe('');

    await browser.evaluate("() => { document.querySelector('textarea').readOnly = false; }");
    await promise;
    expect(await browser.evaluate('result')).toBe('some value');
  });

  test('should retry on invisible element', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.evaluate("() => { document.querySelector('input').style.display = 'none'; }");
    let done = false;
    const promise = browser.locator('input').fill('some value', { timeout: 10_000 }).then(() => (done = true));
    await browser.evaluate(giveItAChanceToFill);
    expect(done).toBe(false);
    expect(await browser.evaluate('result')).toBe('');

    await browser.evaluate("() => { document.querySelector('input').style.display = 'inline'; }");
    await promise;
    expect(await browser.evaluate('result')).toBe('some value');
  });

  test('should be able to fill the body', async ({ browser }) => {
    await browser.goto(content('<body contentEditable="true"></body>'));
    await browser.locator('body').fill('some value');
    expect(await browser.evaluate('() => document.body.textContent')).toBe('some value');
  });

  test('should fill fixed position input', async ({ browser }) => {
    await browser.goto(content("<input style='position: fixed;' />"));
    await browser.locator('input').fill('some value');
    expect(await browser.evaluate("() => document.querySelector('input').value")).toBe('some value');
  });

  test('should be able to fill when focus is in the wrong frame', async ({ browser }) => {
    await browser.goto(content(`
      <div contentEditable="true"></div>
      <iframe></iframe>
    `));
    await browser.locator('iframe').focus();
    await browser.locator('div').fill('some value');
    expect(await browser.evaluate("() => document.querySelector('div').textContent")).toBe('some value');
  });

  test('should be able to fill the input[type=number]', async ({ browser }) => {
    await browser.goto(content('<input id="input" type="number"></input>'));
    await browser.locator('input').fill('42');
    expect(await browser.evaluate('() => window.input.value')).toBe('42');
  });

  test('should be able to fill exponent into the input[type=number]', async ({ browser }) => {
    await browser.goto(content('<input id="input" type="number"></input>'));
    await browser.locator('input').fill('-10e5');
    expect(await browser.evaluate('() => window.input.value')).toBe('-10e5');
  });

  test('should be able to fill input[type=number] with empty string', async ({ browser }) => {
    await browser.goto(content('<input id="input" type="number" value="123"></input>'));
    await browser.locator('input').fill('');
    expect(await browser.evaluate('() => window.input.value')).toBe('');
  });

  test('should not be able to fill text into the input[type=number]', async ({ browser }) => {
    await browser.goto(content('<input id="input" type="number"></input>'));
    const error = await browser.locator('input').fill('abc').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Cannot type text into input[type=number]');
  });

  test('should be able to clear using fill()', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('input').fill('some value');
    expect(await browser.evaluate('result')).toBe('some value');
    await browser.locator('input').fill('');
    expect(await browser.evaluate('result')).toBe('');
  });

  test('should not throw when fill causes navigation', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.goto(content('<input type=date>'));
    await browser.evaluate("() => document.querySelector('input').addEventListener('input', () => window.location.href = '/empty.html')");
    await Promise.all([
      browser.locator('input').fill('2020-03-02'),
      browser.waitForURL(/empty\.html/),
    ]);
    expect(await browser.url()).toContain('empty.html');
  });

  test('fill back to back', async ({ browser }) => {
    await browser.goto(content('<input id="one"></input><input id="two"></input>'));
    await browser.locator('#one').fill('first value');
    await browser.locator('#two').fill('second value');
    await expect(browser.locator('#one')).toHaveValue('first value');
    await expect(browser.locator('#two')).toHaveValue('second value');
  });

  test('should fill contenteditable with focus handler that collapses selection', async ({ browser }) => {
    await browser.goto(content(`
      <div contenteditable="true">initial text</div>
      <script>
        const editor = document.querySelector('[contenteditable]');
        editor.addEventListener('focus', () => {
          const selection = window.getSelection();
          if (selection.rangeCount > 0)
            selection.collapseToEnd();
        });
      </script>
    `));
    await browser.locator('div[contenteditable]').fill('some value');
    expect(await browser.locator('div[contenteditable]').textContent()).toBe('some value');
  });
});
