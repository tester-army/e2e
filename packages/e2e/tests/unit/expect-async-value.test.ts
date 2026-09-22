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

  it('leaves toHaveAccessibleName normalized like text', async () => {
    const button: SemanticNode = { ref: { id: 'node-1', revision: '' }, role: 'button', name: ' Save  now ' };
    const locator = createScreenFixture([button]).getByRole('button');
    await expectFixture(locator).toHaveAccessibleName('Save now');
    await vexpect(expectFixture(locator).toHaveAccessibleName('Save')).rejects.toMatchObject({
      message: vexpect.stringContaining('observed: name "Save now"'),
    });
  });
});
