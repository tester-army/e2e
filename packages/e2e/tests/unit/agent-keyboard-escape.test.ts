import { describe, expect, it } from 'vitest';
import type { ExecutorNode } from '../../src/agent/executor.ts';
import { suggestKeyboardEscape } from '../../src/agent/keyboard-escape.ts';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A signup step as an iOS tree lists it: header, a scroll view with a focused field and a button, the keyboard. */
function wizard(options: { focused?: boolean; keyboard?: boolean; crowded?: boolean } = {}): ExecutorNode {
  const focused = options.focused ?? true;
  const content: ExecutorNode[] = [
    { id: 'n10', role: 'text', name: 'Step 1 of 3', rect: rect(24, 120, 100, 18) },
    { id: 'n11', role: 'text', name: "Let's start with your email", rect: rect(24, 146, 300, 28) },
    { id: 'n12', role: 'textbox', name: 'Email', rect: rect(24, 190, 354, 44), states: focused ? { focused: true } : {} },
    { id: 'n13', role: 'button', name: 'Continue', rect: rect(24, 760, 354, 44) },
  ];
  if (options.crowded === true) {
    for (let i = 0; i < 30; i += 1) content.push({ id: `c${String(i)}`, role: 'text', name: 'row', rect: rect(0, 234 + i * 16, 402, 16) });
  }
  return {
    id: 'root',
    role: 'application',
    rect: rect(0, 0, 402, 874),
    children: [
      { id: 'n1', role: 'navigation', name: 'Wizard', rect: rect(0, 0, 402, 96), children: [{ id: 'n2', role: 'text', name: 'Wizard', rect: rect(150, 60, 100, 20) }] },
      // The content sits in a layout wrapper that spans the whole scroll view, as React Native lists it.
      { id: 'n3', role: 'scroll-view', rect: rect(0, 96, 402, 778), children: [{ id: 'n9', role: 'other', rect: rect(0, 96, 402, 778), children: content }] },
      // iOS hosts the keyboard in its own window, which spans the whole screen.
      ...(options.keyboard === false
        ? []
        : [
            {
              id: 'w0',
              role: 'window',
              name: 'Next keyboard',
              rect: rect(0, 0, 402, 874),
              children: [{ id: 'k0', role: 'keyboard', rect: rect(0, 520, 402, 354), children: [{ id: 'k1', role: 'key', name: 'q', rect: rect(4, 530, 36, 42) }] }],
            },
          ]),
    ],
  };
}

describe('suggestKeyboardEscape', () => {
  it('names blank space in the focused field\'s scroll view, below the field and above the keyboard', () => {
    const escape = suggestKeyboardEscape(wizard());
    expect(escape).toEqual({ kind: 'point', containerId: 'n3', point: { x: 201, y: 258 } });
  });

  it('offers nothing without a keyboard', () => {
    expect(suggestKeyboardEscape(wizard({ keyboard: false }))).toEqual({ kind: 'none', reason: 'no-keyboard' });
  });

  it('falls back to the editable nearest above the keyboard when no field reports focus (iOS with React Native)', () => {
    expect(suggestKeyboardEscape(wizard({ focused: false }))).toEqual({ kind: 'point', containerId: 'n3', point: { x: 201, y: 258 } });
  });

  it('looks above the field when everything below it up to the keyboard is occupied', () => {
    const escape = suggestKeyboardEscape(wizard({ crowded: true }));
    // Between the title text and the field there is no room; above the step label there is.
    expect(escape.kind).toBe('point');
    if (escape.kind === 'point') expect(escape.point.y).toBeLessThan(190);
  });
});
