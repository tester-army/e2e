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
    const screens = ['#n1 heading "Your ticket"\n #n2 text "Reference TK-4972"'];
    expect(isDerivedValue('TK-4972', 'Enter the details of the ticket you were issued earlier.', undefined, screens)).toBe(true);
  });

  it('treats a date or time the model reckoned as derived at run time', () => {
    expect(isDerivedValue('2026-09-03', 'Set the date to today', { note: 'Q3' })).toBe(true);
    expect(isDerivedValue('12/31/2026', 'pick the last day', undefined)).toBe(true);
    expect(isDerivedValue('09:30', 'book the morning slot', undefined)).toBe(true);
  });

  it('treats a value the model composed itself as literal, so the flow replays', () => {
    expect(isDerivedValue('Jane Merchant', 'fill in the signup form with plausible details', undefined)).toBe(false);
    expect(isDerivedValue('jane@example.com', 'fill in the signup form', undefined, ['#n1 text "Step 1 of 3"'])).toBe(false);
  });

  it('does not count a placeholder example the platform repeats on the field\'s wrapper', () => {
    const screens = ['#n1 text "Tell us more about you"\n #n2 text "First name"\n #n3 other "e.g. Jane"\n  #n4 textbox "e.g. Jane" testid="first-name-input"\n #n5 other "Continue"'];
    expect(isDerivedValue('Jane', 'fill in the form with plausible values', undefined, screens)).toBe(false);
  });

  it('does not count a field echoing the typed value as the screen having shown it', () => {
    const screens = ['#n1 text "Step 2 of 3"\n #n2 textbox "Jane" testid="first-name"\n #n3 textbox "Last name"'];
    expect(isDerivedValue('Jane', 'fill in the form', undefined, screens)).toBe(false);
    expect(isDerivedValue('Jane', 'fill in the form', undefined, ['#n9 text "Welcome back, Jane"'])).toBe(true);
  });

  it('matches screen text as whole tokens, never inside a node id or a longer word', () => {
    expect(isDerivedValue('123', 'pay with any CVC', undefined, ['#n20123 textbox "CVC"\n #n20124 text "Pay 10,99 US$"'])).toBe(false);
    expect(isDerivedValue('Jane', 'fill the form', undefined, ['#n1 text "Janet Leigh"'])).toBe(false);
    expect(isDerivedValue('123', 'enter the code', undefined, ['#n1 text "Your code is 123"'])).toBe(true);
  });

  it('never treats an empty value as derived', () => {
    expect(isDerivedValue('', 'anything', undefined)).toBe(false);
  });
});
