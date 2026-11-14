/** The change wait an action arms: the table's window, shortened only for a caret key in a focused text field. */

import { describe, expect, it } from 'vitest';
import { changeWaitAfter, SETTLE_AFTER } from '../../src/agent/settle-policy.ts';

const full = SETTLE_AFTER.tap.changeWaitMs;
const caretWait = 1000;
const textbox = { role: 'textbox', states: { focused: true } };
const unfocused = { role: 'textbox' };

describe('changeWaitAfter', () => {
  it('keeps the table window for an action that can change the screen', () => {
    expect(changeWaitAfter({ name: 'tap', node: { role: 'button' } })).toBe(full);
    expect(changeWaitAfter({ name: 'press', node: textbox, key: 'Enter' })).toBe(full);
    expect(changeWaitAfter({ name: 'press', node: { role: 'combobox' }, key: 'ArrowRight' })).toBe(full);
    expect(changeWaitAfter({ name: 'secondaryTap', node: textbox })).toBe(full);
    expect(changeWaitAfter({ name: 'type', node: textbox })).toBe(full);
  });

  it('keeps the window for a tap, even on the focused field, since a click can open a panel', () => {
    expect(changeWaitAfter({ name: 'tap', node: textbox })).toBe(full);
    expect(changeWaitAfter({ name: 'doubleTap', node: { role: 'searchbox', states: { focused: true } } })).toBe(full);
    expect(changeWaitAfter({ name: 'tap', node: unfocused })).toBe(full);
  });

  it('keeps the window for the first focus of a text field, which may open something', () => {
    expect(changeWaitAfter({ name: 'press', node: unfocused, key: 'ArrowRight' })).toBe(full);
    expect(changeWaitAfter({ name: 'pressKey', key: 'ArrowRight' }, unfocused)).toBe(full);
  });

  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift+ArrowRight', 'Control+Shift+ArrowLeft', 'Control+a', 'Meta+a'])(
    'shortens the window for the caret key %s in a text field',
    (key) => {
      expect(changeWaitAfter({ name: 'press', node: textbox, key })).toBe(caretWait);
      expect(changeWaitAfter({ name: 'pressKey', key }, textbox)).toBe(caretWait);
    },
  );

  it.each(['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Backspace', 'a', 'Alt+ArrowLeft', 'Shift+a', 'Control+Enter'])(
    'keeps the window for %s',
    (key) => {
      expect(changeWaitAfter({ name: 'press', node: textbox, key })).toBe(full);
    },
  );

  it('keeps the window for a caret key outside a text field, or on a focus nobody can name', () => {
    expect(changeWaitAfter({ name: 'press', node: { role: 'tab', states: { focused: true } }, key: 'ArrowRight' })).toBe(full);
    expect(changeWaitAfter({ name: 'press', node: { role: 'slider', states: { focused: true } }, key: 'Home' })).toBe(full);
    expect(changeWaitAfter({ name: 'pressKey', key: 'ArrowRight' })).toBe(full);
    expect(changeWaitAfter({ name: 'pressKey', key: 'ArrowRight' }, { role: 'listbox', states: { focused: true } })).toBe(full);
  });

  it('never lengthens a window and leaves an absent one absent', () => {
    expect(changeWaitAfter({ name: 'scroll' })).toBe(SETTLE_AFTER.scroll.changeWaitMs);
    expect(changeWaitAfter({ name: 'typeSecret', node: textbox })).toBeUndefined();
  });
});
