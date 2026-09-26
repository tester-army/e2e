import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
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

  it('refuses to judge an attribute of a secure field, whose value attribute is withheld, negated or not', async () => {
    const secure: SemanticNode = {
      ref: { id: 'node-1', revision: '' },
      role: 'textbox',
      name: 'Password',
      attributes: { type: 'password' },
      states: { secure: true },
    };
    const locator = createScreenFixture([secure]).getByRole('textbox');
    const denied = {
      code: 'POLICY_DENIED',
      category: 'configuration',
      message: 'reading values from a secure field is denied: getByRole("textbox")',
    };
    await expect(locator.getAttribute('value')).rejects.toMatchObject(denied);
    await expect(expectFixture(locator).toHaveAttribute('value')).rejects.toMatchObject(denied);
    await expect(expectFixture(locator).not.toHaveAttribute('value')).rejects.toMatchObject(denied);
    await expect(expectFixture(locator).toHaveAttribute('value', 'synthetic')).rejects.toMatchObject(denied);
    await expect(expectFixture(locator).not.toHaveAttribute('value', 'synthetic')).rejects.toMatchObject(denied);
    await expect(expectFixture(locator).toHaveAttribute('type', 'password')).rejects.toMatchObject(denied);
  });

  it('still judges the value attribute of a plain field and of one without it', async () => {
    const screen = createScreenFixture([
      { ref: { id: 'node-1', revision: '' }, role: 'textbox', name: 'Plain', attributes: { value: 'synthetic' } },
      { ref: { id: 'node-2', revision: '' }, role: 'textbox', name: 'Blank', attributes: {} },
    ]);
    const plain = screen.getByRole('textbox', { name: 'Plain' });
    const blank = screen.getByRole('textbox', { name: 'Blank' });
    await expectFixture(plain).toHaveAttribute('value', 'synthetic');
    await expectFixture(blank).not.toHaveAttribute('value');
    await expect(expectFixture(plain).not.toHaveAttribute('value', { timeout: 50 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: attribute "value" "synthetic"'),
    });
    await expect(expectFixture(blank).toHaveAttribute('value', { timeout: 50 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: attribute "value" absent'),
    });
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
