import { describe, expect, it } from 'vitest';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';

describe('attribute and focus expectations', () => {
  it('matches attribute presence and values without normalizing whitespace', async () => {
    const screen = createScreenFixture([{
      ref: { id: 'node-1', revision: '' },
      role: 'textbox',
      attributes: { readonly: '', class: 'card  active' },
      states: { focused: true },
    }]);
    const locator = screen.getByRole('textbox');

    await expectFixture(locator).toHaveAttribute('readonly');
    await expectFixture(locator).toHaveAttribute('readonly', '');
    await expectFixture(locator).toHaveAttribute('class', /active/);
    await expectFixture(locator).not.toHaveAttribute('hidden');
    await expectFixture(locator).toBeFocused();
  });
});

describe('attribute names that collide with Object.prototype', () => {
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

  it('an absent attribute is absent whatever its name', async () => {
    const screen = createScreenFixture([{
      ref: { id: 'node-1', revision: '' },
      role: 'button',
      attributes: { type: 'submit' },
    }]);
    const locator = screen.getByRole('button');

    for (const name of inherited) {
      await expectFixture(locator).not.toHaveAttribute(name);
      expect(await locator.getAttribute(name)).toBeNull();
      await expect(expectFixture(locator).toHaveAttribute(name)).rejects.toThrow(`attribute "${name}" absent`);
    }
  });

  it('a present attribute answers its string whatever its name', async () => {
    const screen = createScreenFixture([{
      ref: { id: 'node-1', revision: '' },
      role: 'button',
      attributes: { constructor: 'x', toString: '', ['__proto__']: 'proto' },
    }]);
    const locator = screen.getByRole('button');

    await expectFixture(locator).toHaveAttribute('constructor', 'x');
    await expectFixture(locator).toHaveAttribute('toString', '');
    await expectFixture(locator).toHaveAttribute('__proto__', 'proto');
    expect(await locator.getAttribute('constructor')).toBe('x');
    expect(await locator.getAttribute('toString')).toBe('');
    expect(await locator.getAttribute('__proto__')).toBe('proto');
  });
});
