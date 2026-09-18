import { describe, expect, it } from 'vitest';
import { isDerivedValue } from '../../src/agent/derived.ts';

describe('isDerivedValue', () => {
  it('treats values spelled out by the instruction or the params as literal', () => {
    expect(isDerivedValue('Nimbus Paper Co', 'Add a supplier named "Nimbus Paper Co".', undefined)).toBe(false);
    expect(isDerivedValue('4.25', 'unit price 4.25, unit Ream', undefined)).toBe(false);
    expect(isDerivedValue('Helios Robotics', 'Complete the wizard with the given details', { company: 'Helios Robotics', seats: 25 })).toBe(false);
    expect(isDerivedValue('25', 'fill the form', { seats: 25 })).toBe(false);
    expect(isDerivedValue('  nimbus paper co ', 'Add "Nimbus Paper Co"', undefined)).toBe(false);
  });

  it('treats a value read off a screen the step saw as derived at run time', () => {
    const shown = ['Your ticket', 'Reference TK-4972'];
    expect(isDerivedValue('TK-4972', 'Enter the details of the ticket you were issued earlier.', undefined, { shown })).toBe(true);
    expect(isDerivedValue('TK-4972', 'Enter the ticket reference.', undefined, { shown: new Set(shown) })).toBe(true);
  });

  it('treats any non-literal value as derived once the model was shown a screenshot, which may carry text the tree does not', () => {
    expect(isDerivedValue('TK-4972', 'enter the code drawn on the canvas', undefined, { shown: ['Code'], pixels: true })).toBe(true);
    expect(isDerivedValue('Jane Merchant', 'fill in the form with plausible details', undefined, { pixels: true })).toBe(true);
    expect(isDerivedValue('Nimbus Paper Co', 'Add "Nimbus Paper Co"', undefined, { pixels: true })).toBe(false);
    expect(isDerivedValue('Jane Merchant', 'fill in the form with plausible details', undefined, { pixels: false })).toBe(false);
  });

  it('treats a date or time the model reckoned as derived at run time', () => {
    expect(isDerivedValue('2026-09-03', 'Set the date to today', { note: 'Q3' })).toBe(true);
    expect(isDerivedValue('12/31/2026', 'pick the last day', undefined)).toBe(true);
    expect(isDerivedValue('19-09-2026', 'pick tomorrow', undefined)).toBe(true);
    expect(isDerivedValue('09:30', 'book the morning slot', undefined)).toBe(true);
    expect(isDerivedValue('September 19, 2026', 'schedule this for tomorrow', undefined)).toBe(true);
    expect(isDerivedValue('Sept. 19', 'schedule this for tomorrow', undefined)).toBe(true);
    expect(isDerivedValue('19 Sep 2026', 'schedule this for tomorrow', undefined)).toBe(true);
    expect(isDerivedValue('3rd of March', 'pick a date', undefined)).toBe(false);
    expect(isDerivedValue('Jane March', 'fill in the form', undefined)).toBe(false);
    expect(isDerivedValue('Mayfair 12', 'fill in the address', undefined)).toBe(false);
  });

  it('treats a value the model composed itself as literal, so the flow replays', () => {
    expect(isDerivedValue('Jane Merchant', 'fill in the signup form with plausible details', undefined)).toBe(false);
    expect(isDerivedValue('jane@example.com', 'fill in the signup form', undefined, { shown: ['Step 1 of 3'] })).toBe(false);
    expect(isDerivedValue('Jane', 'fill in the form', undefined, { shown: ['Welcome back, Jane'] })).toBe(true);
  });

  it('matches shown text as whole tokens, never inside a longer word', () => {
    expect(isDerivedValue('123', 'pay with any CVC', undefined, { shown: ['CVC', 'Pay 10,99 US$', 'n20123'] })).toBe(false);
    expect(isDerivedValue('Jane', 'fill the form', undefined, { shown: ['Janet Leigh'] })).toBe(false);
    expect(isDerivedValue('123', 'enter the code', undefined, { shown: ['Your code is 123'] })).toBe(true);
  });

  it('never treats an empty value as derived', () => {
    expect(isDerivedValue('', 'anything', undefined)).toBe(false);
    expect(isDerivedValue('   ', 'anything', undefined)).toBe(false);
  });
});
