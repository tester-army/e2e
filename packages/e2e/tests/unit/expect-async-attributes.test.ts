import { describe, it } from 'vitest';
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
