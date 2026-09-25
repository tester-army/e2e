import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';

describe('toHaveValue', () => {
  const textarea: SemanticNode = { ref: { id: 'node-1', revision: '' }, role: 'textbox', value: 'line1\n\nline2  ' };
  const heading: SemanticNode = { ref: { id: 'node-1', revision: '' }, role: 'heading', text: 'Title' };

  it('compares the raw value, newlines and trailing spaces included', async () => {
    const locator = createScreenFixture([textarea]).getByRole('textbox');
    await expectFixture(locator).toHaveValue('line1\n\nline2  ');
    await expectFixture(locator).toHaveValue(/^line1\n\nline2 {2}$/);
    await expectFixture(locator).not.toHaveValue('line1 line2');
  });

  it('prints the raw value it compared when it fails', async () => {
    const locator = createScreenFixture([textarea]).getByRole('textbox');
    await vexpect(expectFixture(locator).toHaveValue('line1 line2')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: value "line1\\n\\nline2  "'),
    });
  });

  it.each(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox', 'option'])(
    'reads a %s the platform reports without a value as the empty string',
    async (role) => {
      const control: SemanticNode = { ref: { id: 'node-1', revision: '' }, role, testId: 'field' };
      const locator = createScreenFixture([control]).getByTestId('field');
      await expectFixture(locator).toHaveValue('');
      await vexpect(expectFixture(locator).toHaveValue('x')).rejects.toMatchObject({
        code: 'ASSERTION_FAILED',
        message: vexpect.stringContaining('observed: value ""'),
      });
    },
  );

  it('refuses a node without a value, negated or not', async () => {
    const locator = createScreenFixture([heading]).getByRole('heading');
    await vexpect(expectFixture(locator).toHaveValue('')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: no value (not a form control)'),
    });
    await vexpect(expectFixture(locator).not.toHaveValue('Title')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: no value (not a form control)'),
    });
  });

  it('refuses a link, whose name and text are not a value', async () => {
    const link: SemanticNode = { ref: { id: 'node-1', revision: '' }, role: 'link', name: 'Docs', text: 'Docs' };
    const locator = createScreenFixture([link]).getByRole('link');
    await vexpect(expectFixture(locator).toHaveValue('Docs')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: no value (not a form control)'),
    });
    await vexpect(expectFixture(locator).not.toHaveValue('')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: no value (not a form control)'),
    });
  });

  it('refuses to judge a secure field, whose value is withheld, negated or not', async () => {
    const secure: SemanticNode = {
      ref: { id: 'node-1', revision: '' },
      role: 'textbox',
      name: 'Password',
      states: { secure: true },
    };
    const locator = createScreenFixture([secure]).getByRole('textbox');
    const denied = {
      code: 'POLICY_DENIED',
      category: 'configuration',
      message: 'reading values from a secure field is denied: getByRole("textbox")',
    };
    await vexpect(expectFixture(locator).toHaveValue('')).rejects.toMatchObject(denied);
    await vexpect(expectFixture(locator).not.toHaveValue('')).rejects.toMatchObject(denied);
    await vexpect(expectFixture(locator).toHaveText('')).rejects.toMatchObject(denied);
    await vexpect(expectFixture(locator).not.toHaveText('')).rejects.toMatchObject(denied);
    await vexpect(expectFixture(locator).toContainText('')).rejects.toMatchObject(denied);
    await vexpect(expectFixture(locator).toHaveText([''])).rejects.toMatchObject(denied);
  });

  it('still reads a secure field for state and name matchers', async () => {
    const secure: SemanticNode = {
      ref: { id: 'node-1', revision: '' },
      role: 'textbox',
      name: 'Password',
      states: { secure: true, focused: true },
    };
    const locator = createScreenFixture([secure]).getByRole('textbox');
    await expectFixture(locator).toBeFocused();
    await expectFixture(locator).toHaveAccessibleName('Password');
  });

  it('leaves toHaveAccessibleName normalized like text', async () => {
    const button: SemanticNode = { ref: { id: 'node-1', revision: '' }, role: 'button', name: ' Save  now ' };
    const locator = createScreenFixture([button]).getByRole('button');
    await expectFixture(locator).toHaveAccessibleName('Save now');
    await vexpect(expectFixture(locator).toHaveAccessibleName('Save')).rejects.toMatchObject({
      message: vexpect.stringContaining('observed: name "Save now"'),
    });
  });
});
