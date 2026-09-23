import { describe, expect, it } from 'vitest';
import { derivedReason } from '../../src/agent/derived.ts';

describe('derivedReason', () => {
  it('treats values spelled out by the instruction or the params as literal', () => {
    expect(derivedReason('Nimbus Paper Co', 'Add a supplier named "Nimbus Paper Co".', undefined)).toBeUndefined();
    expect(derivedReason('4.25', 'unit price 4.25, unit Ream', undefined)).toBeUndefined();
    expect(derivedReason('Helios Robotics', 'Complete the wizard with the given details', { company: 'Helios Robotics', seats: 25 })).toBeUndefined();
    expect(derivedReason('25', 'fill the form', { seats: 25 })).toBeUndefined();
    expect(derivedReason('  nimbus paper co ', 'Add "Nimbus Paper Co"', undefined)).toBeUndefined();
  });

  it('names the token rule for a reference read off a screen the step saw, and the node rule when a node says exactly that', () => {
    const shown = ['Your ticket', 'Reference TK-4972'];
    expect(derivedReason('TK-4972', 'Enter the details of the ticket you were issued earlier.', undefined, { shown })).toBe('minted-token');
    expect(derivedReason('TK-4972', 'Enter the ticket reference.', undefined, { shown: new Set(shown) })).toBe('minted-token');
    expect(derivedReason('TK-4972', 'Enter the ticket reference.', undefined, { shown: ['Reference', 'TK-4972'] })).toBe('whole-node');
  });

  it('names pixels for any non-literal value once the model was shown a screenshot, which may carry text the tree does not', () => {
    expect(derivedReason('TK-4972', 'enter the code drawn on the canvas', undefined, { shown: ['Code'], pixels: true })).toBe('pixels');
    expect(derivedReason('Jane Merchant', 'fill in the form with plausible details', undefined, { pixels: true })).toBe('pixels');
    expect(derivedReason('Nimbus Paper Co', 'Add "Nimbus Paper Co"', undefined, { pixels: true })).toBeUndefined();
    expect(derivedReason('Jane Merchant', 'fill in the form with plausible details', undefined, { pixels: false })).toBeUndefined();
  });

  it('names the date rule for a date or time the model reckoned', () => {
    expect(derivedReason('2026-09-03', 'Set the date to today', { note: 'Q3' })).toBe('date');
    expect(derivedReason('12/31/2026', 'pick the last day', undefined)).toBe('date');
    expect(derivedReason('19-09-2026', 'pick tomorrow', undefined)).toBe('date');
    expect(derivedReason('09:30', 'book the morning slot', undefined)).toBe('date');
    expect(derivedReason('September 19, 2026', 'schedule this for tomorrow', undefined)).toBe('date');
    expect(derivedReason('Sept. 19', 'schedule this for tomorrow', undefined)).toBe('date');
    expect(derivedReason('19 Sep 2026', 'schedule this for tomorrow', undefined)).toBe('date');
    expect(derivedReason('3rd of March', 'pick a date', undefined)).toBeUndefined();
    expect(derivedReason('Jane March', 'fill in the form', undefined)).toBeUndefined();
    expect(derivedReason('Mayfair 12', 'fill in the address', undefined)).toBeUndefined();
  });

  it('treats a value the model composed itself as literal, so the flow replays', () => {
    expect(derivedReason('Jane Merchant', 'fill in the signup form with plausible details', undefined)).toBeUndefined();
    expect(derivedReason('jane@example.com', 'fill in the signup form', undefined, { shown: ['Step 1 of 3'] })).toBeUndefined();
  });

  it('reads a value off the screen when a node says exactly that, never a word inside a sentence', () => {
    expect(derivedReason('Jane', 'fill in the form', undefined, { shown: ['Jane', 'Sign out'] })).toBe('whole-node');
    expect(derivedReason('Jane', 'fill in the form', undefined, { shown: ['  jane '] })).toBe('whole-node');
    // Decided: a name inside a greeting is not the screen showing the value,
    // so the fill replays. The cost is a false negative when the model did
    // read it there: the replay types last run's name and self-finalizes,
    // backstopped only when the value resurfaces in the end anchors. Taken
    // so that the words a model composes keep replaying, as below.
    expect(derivedReason('Jane', 'fill in the form', undefined, { shown: ['Welcome back, Jane'] })).toBeUndefined();
    // The regression: a page listing "Row one" and "Row two" does not make
    // the words the model typed into its fields the screen's data.
    const rows = ['Row one', 'Row two', 'Filled'];
    expect(derivedReason('one', 'fill the two fields', undefined, { shown: rows })).toBeUndefined();
    expect(derivedReason('two', 'fill the two fields', undefined, { shown: rows })).toBeUndefined();
  });

  it('matches a data-shaped value as a whole token of shown text, never inside a longer one', () => {
    expect(derivedReason('123', 'pay with any CVC', undefined, { shown: ['CVC', 'Pay 10,99 US$', 'n20123'] })).toBeUndefined();
    expect(derivedReason('Jane', 'fill the form', undefined, { shown: ['Janet Leigh'] })).toBeUndefined();
    expect(derivedReason('123', 'enter the code', undefined, { shown: ['Your code is 123'] })).toBe('minted-token');
    expect(derivedReason('TK-4972', 'enter the reference', undefined, { shown: ['Reference: TK-4972.'] })).toBe('minted-token');
    expect(derivedReason('A1B2', 'enter the code', undefined, { shown: ['Code A1B2 expires soon'] })).toBe('minted-token');
  });

  it('flags a digit the model chose beside a numbered label: a known limit of the glyph test', () => {
    // "1" typed into the field beside "Row 1" is the model's own choice, yet
    // the digit makes it data-shaped and the label shows it as a word of its
    // own, so the token rule cannot tell it from a code. Accepted: the cost
    // is a gap where a replay was possible, and the executor runs that part
    // live; the opposite error would replay a minted value as the flow's data.
    expect(derivedReason('1', 'fill the fields', undefined, { shown: ['Row 1', 'Row 2'] })).toBe('minted-token');
  });

  it('prefers the node rule over the token rule when both apply', () => {
    expect(derivedReason('123', 'enter the code', undefined, { shown: ['Your code is 123', '123'] })).toBe('whole-node');
  });

  it('never treats an empty value as derived', () => {
    expect(derivedReason('', 'anything', undefined)).toBeUndefined();
    expect(derivedReason('   ', 'anything', undefined)).toBeUndefined();
  });
});
