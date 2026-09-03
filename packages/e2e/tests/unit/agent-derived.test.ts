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

  it('treats a value found nowhere in the step as derived at run time', () => {
    expect(isDerivedValue('TK-4972', 'Enter the details of the ticket you were issued earlier.', undefined)).toBe(true);
    expect(isDerivedValue('2026-09-03', 'Set the date to today', { note: 'Q3' })).toBe(true);
  });

  it('never treats an empty value as derived', () => {
    expect(isDerivedValue('', 'anything', undefined)).toBe(false);
  });
});
