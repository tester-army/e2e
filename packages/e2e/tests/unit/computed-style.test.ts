import { describe, expect, it } from 'vitest';
import { validateComputedStyleProperties, type ComputedStyleProperty } from '../../src/engine/computed-style.ts';

describe('computed style properties', () => {
  it.each([undefined, null, {}, 'color', [], ['content'], ['background-image'], ['--token'], ['COLOR'], ['color', 'content'], Array(1)])(
    'refuses a request outside the allow-list before engine access: %j',
    (properties) => {
      expect(() => validateComputedStyleProperties(properties as ComputedStyleProperty[])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    },
  );

  it('copies and deduplicates the property list', () => {
    const properties: ComputedStyleProperty[] = [...Array<ComputedStyleProperty>(11).fill('color'), 'opacity'];
    const checked = validateComputedStyleProperties(properties);
    expect(checked).toEqual(['color', 'opacity']);
    expect(checked).not.toBe(properties);
  });
});
