/**
 * Adapted from microsoft/playwright tests/page/page-keyboard.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.type(selector, text)` is a locator pressSequentially, and an
 * element press of a key `locator.press` does not name (a code like `Digit5`) is a focus and a keyboard press.
 */

/*
 * Not ported:
 * - should send a character with insertText: no `keyboard.insertText`.
 * - insertText should only emit input event: no `keyboard.insertText`.
 * - should expose keyIdentifier in webkit: WebKit only.
 * - should dispatch insertText after context menu was opened: no `keyboard.insertText`, and `mouse.down` presses only the primary button.
 * - should type after context menu was opened: `mouse.down` presses only the primary button.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, CROSS } from './helpers.ts';

/** Records the last keydown in `window.lastEvent`, Playwright's `captureLastKeydown`. */
const captureLastKeydown = `() => {
  const lastEvent = { repeat: false, location: -1, code: '', key: '', metaKey: false, keyIdentifier: 'unsupported' };
  window.lastEvent = lastEvent;
  document.addEventListener('keydown', (e) => {
    lastEvent.repeat = e.repeat;
    lastEvent.location = e.location;
    lastEvent.key = e.key;
    lastEvent.code = e.code;
    lastEvent.metaKey = e.metaKey;
    lastEvent.keyIdentifier = 'keyIdentifier' in e && typeof e.keyIdentifier === 'string' && e.keyIdentifier;
  }, true);
}`;

const isMac = process.platform === 'darwin';

test.describe('page keyboard', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should type into a textarea', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate("() => { const textarea = document.createElement('textarea'); document.body.appendChild(textarea); textarea.focus(); }");
    const text = 'Hello world. I am the text that was typed!';
    await browser.keyboard.type(text);
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe(text);
  });

  test('should move with the arrow keys', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').pressSequentially('Hello World!');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('Hello World!');
    for (let i = 0; i < 'World!'.length; i++) await browser.keyboard.press('ArrowLeft');
    await browser.keyboard.type('inserted ');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('Hello inserted World!');
    await browser.keyboard.down('Shift');
    for (let i = 0; i < 'inserted '.length; i++) await browser.keyboard.press('ArrowLeft');
    await browser.keyboard.up('Shift');
    await browser.keyboard.press('Backspace');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('Hello World!');
  });

  test('should send a character with ElementHandle.press', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    const textarea = browser.locator('textarea');
    await textarea.press('a');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('a');

    await browser.evaluate("() => window.addEventListener('keydown', (e) => e.preventDefault(), true)");

    await textarea.press('b');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('a');
  });

  test('should not type text with Alt modifier', async ({ browser }) => {
    await browser.goto(content('<input><textarea></textarea><div contenteditable></div>'));
    for (const locator of [browser.locator('input'), browser.locator('textarea'), browser.locator('div')]) {
      await locator.focus();
      await browser.keyboard.press('Alt+KeyA');
      await browser.keyboard.press('Alt+Digit1');
      await browser.keyboard.press('Alt+Shift+KeyA');
      await browser.keyboard.down('Alt');
      await browser.keyboard.press('b');
      await browser.keyboard.up('Alt');
      await locator.press('c');
    }
    await expect(browser.locator('input')).toHaveValue('c');
    await expect(browser.locator('textarea')).toHaveValue('c');
    await expect(browser.locator('div')).toHaveText('c');
  });

  test('should emit keydown, keypress, textInput and input when typing a character', async ({ browser }) => {
    await browser.goto(content('<input>'));
    await browser.evaluate(`() => {
      window.events = [];
      for (const type of ['keydown', 'keypress', 'textInput', 'input', 'keyup'])
        document.querySelector('input').addEventListener(type, () => window.events.push(type));
    }`);
    await browser.locator('input').focus();
    await browser.keyboard.press('f');
    expect(await browser.evaluate('events')).toEqual(['keydown', 'keypress', 'textInput', 'input', 'keyup']);
  });

  test('should dispatch key events in separate tasks', async ({ browser }) => {
    await browser.goto(content('<input>'));
    await browser.evaluate(`() => {
      window.log = [];
      const input = document.querySelector('input');
      for (const type of ['keydown', 'keypress'])
        input.addEventListener(type, () => { window.log.push(type); queueMicrotask(() => window.log.push('microtask-' + type)); });
      input.focus();
    }`);
    await browser.keyboard.press('a');
    expect(await browser.evaluate('log')).toEqual(['keydown', 'microtask-keydown', 'keypress', 'microtask-keypress']);
  });

  test('should report shiftKey', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    const keyboard = browser.keyboard;
    const codeForKey = { 'Shift': 16, 'Alt': 18, 'Control': 17 };
    for (const modifierKey in codeForKey) {
      await keyboard.down(modifierKey);
      expect(await browser.evaluate('getResult()')).toBe('Keydown: ' + modifierKey + ' ' + modifierKey + 'Left LEFT [' + modifierKey + ']');
      await keyboard.down('!');
      if (modifierKey === 'Shift') expect(await browser.evaluate('getResult()')).toBe('Keydown: ! Digit1 STANDARD [' + modifierKey + ']\nKeypress: ! Digit1 STANDARD 33 [' + modifierKey + ']');
      else expect(await browser.evaluate('getResult()')).toBe('Keydown: ! Digit1 STANDARD [' + modifierKey + ']');

      await keyboard.up('!');
      expect(await browser.evaluate('getResult()')).toBe('Keyup: ! Digit1 STANDARD [' + modifierKey + ']');
      await keyboard.up(modifierKey);
      expect(await browser.evaluate('getResult()')).toBe('Keyup: ' + modifierKey + ' ' + modifierKey + 'Left LEFT []');
    }
  });

  test('should report multiple modifiers', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    const keyboard = browser.keyboard;
    await keyboard.down('Control');
    expect(await browser.evaluate('getResult()')).toBe('Keydown: Control ControlLeft LEFT [Control]');
    await keyboard.down('Alt');
    expect(await browser.evaluate('getResult()')).toBe('Keydown: Alt AltLeft LEFT [Alt Control]');
    await keyboard.down(';');
    expect(await browser.evaluate('getResult()')).toBe('Keydown: ; Semicolon STANDARD [Alt Control]');
    await keyboard.up(';');
    expect(await browser.evaluate('getResult()')).toBe('Keyup: ; Semicolon STANDARD [Alt Control]');
    await keyboard.up('Control');
    expect(await browser.evaluate('getResult()')).toBe('Keyup: Control ControlLeft LEFT [Alt]');
    await keyboard.up('Alt');
    expect(await browser.evaluate('getResult()')).toBe('Keyup: Alt AltLeft LEFT []');
  });

  test('should send proper codes while typing', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.type('!');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: ! Digit1 STANDARD []',
        'Keypress: ! Digit1 STANDARD 33 []',
        'Keyup: ! Digit1 STANDARD []'].join('\n'));
    await browser.keyboard.type('^');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: ^ Digit6 STANDARD []',
        'Keypress: ^ Digit6 STANDARD 94 []',
        'Keyup: ^ Digit6 STANDARD []'].join('\n'));
  });

  test('should send proper codes while typing with shift', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    const keyboard = browser.keyboard;
    await keyboard.down('Shift');
    await browser.keyboard.type('~');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: Shift ShiftLeft LEFT [Shift]',
        'Keydown: ~ Backquote STANDARD [Shift]',
        'Keypress: ~ Backquote STANDARD 126 [Shift]',
        'Keyup: ~ Backquote STANDARD [Shift]'].join('\n'));
    await keyboard.up('Shift');
  });

  test('should not type canceled events', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').focus();
    await browser.evaluate(`() => {
      window.addEventListener('keydown', (event) => {
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.key === 'l')
          event.preventDefault();
        if (event.key === 'o')
          event.preventDefault();
      }, false);
    }`);
    await browser.keyboard.type('Hello World!');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('He Wrd!');
  });

  test('should press plus', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('+');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: + Equal STANDARD []',
        'Keypress: + Equal STANDARD 43 []',
        'Keyup: + Equal STANDARD []'].join('\n'));
  });

  test('should press shift plus', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('Shift++');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: Shift ShiftLeft LEFT [Shift]',
        'Keydown: + Equal STANDARD [Shift]',
        'Keypress: + Equal STANDARD 43 [Shift]',
        'Keyup: + Equal STANDARD [Shift]',
        'Keyup: Shift ShiftLeft LEFT []'].join('\n'));
  });

  test('should support plus-separated modifiers', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('Shift+~');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: Shift ShiftLeft LEFT [Shift]',
        'Keydown: ~ Backquote STANDARD [Shift]',
        'Keypress: ~ Backquote STANDARD 126 [Shift]',
        'Keyup: ~ Backquote STANDARD [Shift]',
        'Keyup: Shift ShiftLeft LEFT []'].join('\n'));
  });

  test('should support multiple plus-separated modifiers', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('Control+Shift+~');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: Control ControlLeft LEFT [Control]',
        'Keydown: Shift ShiftLeft LEFT [Control Shift]',
        'Keydown: ~ Backquote STANDARD [Control Shift]',
        'Keyup: ~ Backquote STANDARD [Control Shift]',
        'Keyup: Shift ShiftLeft LEFT [Control]',
        'Keyup: Control ControlLeft LEFT []'].join('\n'));
  });

  test('should shift raw codes', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('Shift+Digit3');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: Shift ShiftLeft LEFT [Shift]',
        'Keydown: # Digit3 STANDARD [Shift]',
        'Keypress: # Digit3 STANDARD 35 [Shift]',
        'Keyup: # Digit3 STANDARD [Shift]',
        'Keyup: Shift ShiftLeft LEFT []'].join('\n'));
  });

  test('should specify repeat property', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').focus();
    await browser.evaluate(captureLastKeydown);
    await browser.keyboard.down('a');
    expect(await browser.evaluate('lastEvent.repeat')).toBe(false);
    await browser.keyboard.press('a');
    expect(await browser.evaluate('lastEvent.repeat')).toBe(true);

    await browser.keyboard.down('b');
    expect(await browser.evaluate('lastEvent.repeat')).toBe(false);
    await browser.keyboard.down('b');
    expect(await browser.evaluate('lastEvent.repeat')).toBe(true);

    await browser.keyboard.up('a');
    await browser.keyboard.down('a');
    expect(await browser.evaluate('lastEvent.repeat')).toBe(false);
  });

  test('should type all kinds of characters', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').focus();
    const text = 'This text goes onto two lines.\nThis character is 嗨.';
    await browser.keyboard.type(text);
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe(text);
  });

  test('should specify location', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.evaluate(captureLastKeydown);
    const textarea = browser.locator('textarea');

    await textarea.focus();
    await browser.keyboard.press('Digit5');
    expect.soft(await browser.evaluate('lastEvent.location')).toBe(0);
    expect.soft(await browser.evaluate('lastEvent.key')).toBe('5');
    expect.soft(await browser.evaluate('lastEvent.code')).toBe('Digit5');

    await textarea.focus();
    await browser.keyboard.press('ControlLeft');
    expect.soft(await browser.evaluate('lastEvent.location')).toBe(1);
    expect.soft(await browser.evaluate('lastEvent.key')).toBe('Control');
    expect.soft(await browser.evaluate('lastEvent.code')).toBe('ControlLeft');

    await textarea.focus();
    await browser.keyboard.press('ControlRight');
    expect.soft(await browser.evaluate('lastEvent.location')).toBe(2);
    expect.soft(await browser.evaluate('lastEvent.key')).toBe('Control');
    expect.soft(await browser.evaluate('lastEvent.code')).toBe('ControlRight');

    await textarea.focus();
    await browser.keyboard.press('NumpadSubtract');
    expect.soft(await browser.evaluate('lastEvent.location')).toBe(3);
    expect.soft(await browser.evaluate('lastEvent.key')).toBe('-');
    expect.soft(await browser.evaluate('lastEvent.code')).toBe('NumpadSubtract');
  });

  test('should specify numpad location on keyup', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('NumpadSubtract');
    expect(await browser.evaluate('getResult()')).toBe(
      ['Keydown: - NumpadSubtract NUMPAD []',
        'Keypress: - NumpadSubtract NUMPAD 45 []',
        'Keyup: - NumpadSubtract NUMPAD []'].join('\n'));
  });

  test('should press NumpadDecimal as Delete', async ({ browser }) => {
    await browser.goto(content('<textarea></textarea>'));
    await browser.evaluate(captureLastKeydown);
    const textarea = browser.locator('textarea');

    await textarea.focus();
    await browser.keyboard.press('NumpadDecimal');
    expect(await browser.evaluate('lastEvent.key')).toBe('Delete');
    expect(await browser.evaluate('lastEvent.code')).toBe('NumpadDecimal');
    expect(await browser.evaluate('lastEvent.location')).toBe(3);
    await expect(textarea).toHaveValue('');
  });

  test('should type numpad digits with Shift', async ({ browser }) => {
    await browser.goto(content('<textarea></textarea>'));
    const textarea = browser.locator('textarea');
    await textarea.focus();
    await browser.keyboard.press('Shift+Numpad1');
    await browser.keyboard.press('Shift+NumpadDecimal');
    await browser.keyboard.press('Shift+Numpad9');
    await expect(textarea).toHaveValue('1.9');
  });

  test('should press Enter', async ({ browser }) => {
    await browser.goto(content('<textarea></textarea>'));
    await browser.locator('textarea').focus();
    await browser.evaluate(captureLastKeydown);
    for (const [key, expectedKey, expectedCode] of [
      ['Enter', 'Enter', 'Enter'],
      ['NumpadEnter', 'Enter', 'NumpadEnter'],
      ['\n', 'Enter', 'Enter'],
      ['\r', 'Enter', 'Enter'],
    ] as const) {
      await browser.keyboard.press(key);
      expect(await browser.evaluate('lastEvent.key')).toBe(expectedKey);
      expect(await browser.evaluate('lastEvent.code')).toBe(expectedCode);
      expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('\n');
      await browser.evaluate("() => { document.querySelector('textarea').value = ''; }");
    }
  });

  test('should press audio and media control keys', async ({ browser }) => {
    await browser.goto(content('<input autofocus>'));
    await browser.locator('input').focus();
    await browser.evaluate(captureLastKeydown);
    const mediaKeys = [
      { key: 'AudioVolumeMute', code: 'AudioVolumeMute' },
      { key: 'AudioVolumeDown', code: 'AudioVolumeDown' },
      { key: 'AudioVolumeUp', code: 'AudioVolumeUp' },
      { key: 'MediaTrackNext', code: 'MediaTrackNext' },
      { key: 'MediaTrackPrevious', code: 'MediaTrackPrevious' },
      { key: 'MediaPlayPause', code: 'MediaPlayPause' },
    ];
    for (const mediaKey of mediaKeys) {
      await browser.keyboard.press(mediaKey.key);
      expect.soft(await browser.evaluate('lastEvent.key')).toBe(mediaKey.key);
      expect.soft(await browser.evaluate('lastEvent.code')).toBe(mediaKey.code);
      expect.soft(await browser.evaluate('lastEvent.location')).toBe(0);
    }
  });

  test('should throw on unknown keys', async ({ browser }) => {
    await browser.goto('/empty.html');
    let error = await browser.keyboard.press('NotARealKey').catch((caught: Error) => caught);
    expect((error as Error).message).toContain('Unknown key: "NotARealKey"');

    error = await browser.keyboard.press('ё').catch((caught: Error) => caught);
    expect(error && (error as Error).message).toContain('Unknown key: "ё"');

    error = await browser.keyboard.press('😊').catch((caught: Error) => caught);
    expect(error && (error as Error).message).toContain('Unknown key: "😊"');
  });

  test('should type emoji', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').pressSequentially('👹 Tokyo street Japan 🇯🇵');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('👹 Tokyo street Japan 🇯🇵');
  });

  test('should type emoji into an iframe', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate(`() => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.id = 'emoji-test';
      frame.src = '/input/textarea.html';
      frame.onload = () => resolve();
      document.body.appendChild(frame);
    })`);
    await browser.frameLocator('#emoji-test').locator('textarea').pressSequentially('👹 Tokyo street Japan 🇯🇵');
    expect(await browser.evaluate("() => document.querySelector('#emoji-test').contentDocument.querySelector('textarea').value")).toBe('👹 Tokyo street Japan 🇯🇵');
  });

  test('should handle selectAll', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').pressSequentially('some text');
    await browser.keyboard.down('ControlOrMeta');
    await browser.keyboard.press('a');
    await browser.keyboard.up('ControlOrMeta');
    await browser.keyboard.press('Backspace');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('');
  });

  test('pressing Meta should not result in any text insertion on any platform', async ({ browser }) => {
    await browser.goto(content('<input type="text" value="hello world">'));
    const input = browser.locator('input');
    await expect(input).toHaveValue('hello world');
    await input.focus();
    await browser.keyboard.press('Meta');
    await expect(input).toHaveValue('hello world');
  });

  test('should be able to prevent selectAll', async ({ browser }) => {
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').pressSequentially('some text');
    await browser.evaluate(`() => {
      document.querySelector('textarea').addEventListener('keydown', (event) => {
        if (event.key === 'a' && (event.metaKey || event.ctrlKey))
          event.preventDefault();
      }, false);
    }`);
    await browser.keyboard.down('ControlOrMeta');
    await browser.keyboard.press('a');
    await browser.keyboard.up('ControlOrMeta');
    await browser.keyboard.press('Backspace');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('some tex');
  });

  test('should support MacOS shortcuts', async ({ browser }) => {
    test.skip(!isMac);
    await browser.goto('/input/textarea.html');
    await browser.locator('textarea').pressSequentially('some text');
    await browser.keyboard.press('Shift+Control+Alt+KeyB');
    await browser.keyboard.press('Backspace');
    expect(await browser.evaluate("() => document.querySelector('textarea').value")).toBe('some ');
  });

  test('should press the meta key', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate(captureLastKeydown);
    await browser.keyboard.press('Meta');
    const { key, code, metaKey } = await browser.evaluate<{ key: string; code: string; metaKey: boolean }>('lastEvent');
    expect(key).toBe('Meta');
    expect(code).toBe('MetaLeft');
    expect(metaKey).toBe(true);
  });

  test('should work with keyboard events with empty.html', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate(captureLastKeydown);
    await browser.keyboard.press('a');
    expect(await browser.evaluate('lastEvent.key')).toBe('a');
  });

  test('should work after a cross origin navigation', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.goto(`${CROSS}/empty.html`);
    await browser.evaluate(captureLastKeydown);
    await browser.keyboard.press('a');
    expect(await browser.evaluate('lastEvent.key')).toBe('a');
  });

  test('should scroll with PageDown', async ({ browser }) => {
    await browser.goto('/input/scrollable.html');
    await browser.locator('body').tap();
    await browser.keyboard.press('PageDown');
    await expect.poll(() => browser.evaluate('scrollY > 0')).toBe(true);
  });

  test('should move around the selection in a contenteditable', async ({ browser }) => {
    await browser.goto(content('<div contenteditable></div>'));
    await browser.locator('div').focus();
    const modifier = isMac ? 'Alt' : 'Control';
    await browser.keyboard.type('Hello World');
    await browser.keyboard.down(modifier);
    await browser.keyboard.down('Shift');
    await browser.keyboard.press('ArrowLeft');
    await browser.keyboard.up('Shift');
    await browser.keyboard.up(modifier);
    expect(await browser.evaluate('() => window.getSelection().toString()')).toBe('World');
  });

  test('should move to the start of the document', async ({ browser }) => {
    test.skip(!isMac);
    await browser.goto(content('<div contenteditable></div>'));
    await browser.locator('div').focus();
    await browser.keyboard.type('1\n2\n3\n');
    await browser.keyboard.press('Shift+Meta+ArrowUp');
    expect(await browser.evaluate('() => window.getSelection().toString()')).toBe('1\n2\n3\n');
  });

  test('should dispatch a click event on a button when Space gets pressed', async ({ browser }) => {
    await browser.goto(content('<button type="button">a11y</button>'));
    await browser.evaluate("() => { window.actual = { clicked: false }; document.querySelector('button').addEventListener('click', () => (window.actual.clicked = true)); }");
    await browser.locator('button').focus();
    await browser.keyboard.press('Space');
    expect(await browser.evaluate('actual.clicked')).toBe(true);
  });

  test('should dispatch a click event on a button when Enter gets pressed', async ({ browser }) => {
    await browser.goto(content('<button type="button">a11y</button>'));
    await browser.evaluate("() => { window.actual = { clicked: false }; document.querySelector('button').addEventListener('click', () => (window.actual.clicked = true)); }");
    await browser.locator('button').focus();
    await browser.keyboard.press('Enter');
    expect(await browser.evaluate('actual.clicked')).toBe(true);
  });

  test('should support simple copy-pasting', async ({ browser }) => {
    await browser.goto(content('<div contenteditable>123</div>'));
    await browser.locator('div').focus();
    await browser.keyboard.press('ControlOrMeta+KeyA');
    await browser.keyboard.press('ControlOrMeta+KeyC');
    await browser.keyboard.press('ControlOrMeta+KeyV');
    await browser.keyboard.press('ControlOrMeta+KeyV');
    expect(await browser.evaluate("() => document.querySelector('div').textContent")).toBe('123123');
  });

  test('should support simple cut-pasting', async ({ browser }) => {
    await browser.goto(content('<div contenteditable>123</div>'));
    await browser.locator('div').focus();
    await browser.keyboard.press('ControlOrMeta+KeyA');
    await browser.keyboard.press('ControlOrMeta+KeyX');
    await browser.keyboard.press('ControlOrMeta+KeyV');
    await browser.keyboard.press('ControlOrMeta+KeyV');
    expect(await browser.evaluate("() => document.querySelector('div').textContent")).toBe('123123');
  });

  test('should support undo-redo', async ({ browser }) => {
    await browser.goto(content('<div contenteditable></div>'));
    const div = browser.locator('div');
    await expect(div).toHaveText('');
    await div.pressSequentially('123');
    await expect(div).toHaveText('123');
    await browser.keyboard.press('ControlOrMeta+KeyZ');
    await expect(div).toHaveText('');
    await browser.keyboard.press('Shift+ControlOrMeta+KeyZ');
    await expect(div).toHaveText('123');
  });

  test('should type repeatedly in contenteditable in shadow dom', async ({ browser }) => {
    await browser.goto(content(`
      <html>
        <body>
          <shadow-element></shadow-element>
          <script>
            customElements.define('shadow-element', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'open' });
              }

              connectedCallback() {
                this.shadowRoot.innerHTML = \`
                  <style>
                    .editor { padding: 1rem; margin: 1rem; border: 1px solid #ccc; }
                  </style>
                  <div class=editor contenteditable id=foo></div>
                  <hr>
                  <section>
                    <div class=editor contenteditable id=bar></div>
                  </section>
                \`;
              }
            });
          </script>
        </body>
      </html>
    `));

    const editor = browser.locator('shadow-element > .editor').first();
    await editor.pressSequentially('This is the first box.');

    const sectionEditor = browser.locator('section .editor');
    await sectionEditor.pressSequentially('This is the second box.');

    expect(await editor.textContent()).toBe('This is the first box.');
    expect(await sectionEditor.textContent()).toBe('This is the second box.');
  });

  test('should type repeatedly in contenteditable in shadow dom with nested elements', async ({ browser }) => {
    await browser.goto(content(`
      <html>
        <body>
          <shadow-element></shadow-element>
          <script>
            customElements.define('shadow-element', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'open' });
              }

              connectedCallback() {
                this.shadowRoot.innerHTML = \`
                  <style>
                    .editor { padding: 1rem; margin: 1rem; border: 1px solid #ccc; }
                  </style>
                  <div class=editor contenteditable id=foo><p>hello</p></div>
                  <hr>
                  <section>
                    <div class=editor contenteditable id=bar><p>world</p></div>
                  </section>
                \`;
              }
            });
          </script>
        </body>
      </html>
    `));

    const editor = browser.locator('shadow-element > .editor').first();
    await editor.pressSequentially('This is the first box: ');

    const sectionEditor = browser.locator('section .editor');
    await sectionEditor.pressSequentially('This is the second box: ');

    expect(await editor.textContent()).toBe('This is the first box: hello');
    expect(await sectionEditor.textContent()).toBe('This is the second box: world');
  });

  test('should type repeatedly in input in shadow dom', async ({ browser }) => {
    await browser.goto(content(`
      <html>
        <body>
          <shadow-element></shadow-element>
          <script>
            customElements.define('shadow-element', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'open' });
              }

              connectedCallback() {
                this.shadowRoot.innerHTML = \`
                  <style>
                    .editor { padding: 1rem; margin: 1rem; border: 1px solid #ccc; }
                  </style>
                  <input class=editor id=foo>
                  <hr>
                  <section>
                    <input class=editor id=bar>
                  </section>
                \`;
              }
            });
          </script>
        </body>
      </html>
    `));

    const editor = browser.locator('shadow-element > .editor').first();
    await editor.pressSequentially('This is the first box.');

    const sectionEditor = browser.locator('section .editor');
    await sectionEditor.pressSequentially('This is the second box.');

    expect(await editor.inputValue()).toBe('This is the first box.');
    expect(await sectionEditor.inputValue()).toBe('This is the second box.');
  });

  test('type to non-focusable element should maintain old focus', async ({ browser }) => {
    await browser.goto(content(`
      <div id="focusable" tabindex="0">focusable div</div>
      <div id="non-focusable-and-non-editable">non-editable, non-focusable</div>
    `));

    await browser.locator('#focusable').focus();
    expect(await browser.evaluate('() => document.activeElement?.id')).toBe('focusable');
    await browser.locator('#non-focusable-and-non-editable').pressSequentially('foo');
    expect(await browser.evaluate('() => document.activeElement?.id')).toBe('focusable');
  });

  test('should have correct Keydown/Keyup order when pressing Escape key', async ({ browser }) => {
    await browser.goto('/input/keyboard.html');
    await browser.keyboard.press('Escape');
    expect(await browser.evaluate('getResult()')).toBe(`
Keydown: Escape Escape STANDARD []
Keyup: Escape Escape STANDARD []
`.trim());
  });

  test('should close dialog on Escape key press in contenteditable', async ({ browser }) => {
    await browser.goto(content(`
      <dialog>
        <div contenteditable>Edit Me</div>
      </dialog>
    `));
    const widget = browser.locator('dialog [contenteditable]');
    await browser.evaluate("() => document.querySelector('dialog').showModal()");
    await expect.poll(() => browser.evaluate("() => document.querySelector('dialog').open")).toBe(true);
    await expect(widget).toBeVisible();

    await widget.press('Escape');
    await expect.poll(() => browser.evaluate("() => document.querySelector('dialog').open")).toBe(false);
    await expect(widget).not.toBeVisible();
  });
});
