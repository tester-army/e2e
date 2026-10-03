/**
 * `locator.selectOption(value)` takes one option per call: a label string or
 * an object naming exactly one of `label`, `value`, or `index`. Any other
 * shape, an array of options above all, must fail before the engine acts:
 * the web engine would read an array as an option object and select
 * something other than what the test asked for.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorAction, SemanticNode } from '../../src/engine/index.ts';
import type { SelectOption } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const FREQUENCY: SemanticNode = { ref: { id: 'frequency', revision: '' }, role: 'listbox', name: 'Frequency' };

/** A screen over one select, logging every action the engine is asked to perform. */
function selectScreen() {
  const performed: LocatorAction[] = [];
  const { screen } = screenOver({
    observe: () => snapshot([FREQUENCY]),
    locate: () => [FREQUENCY],
    perform: (_, action) => {
      performed.push(action);
    },
    timeoutMs: 300,
  });
  return { select: screen.getByRole('listbox', { name: 'Frequency' }), performed };
}

describe('locator.selectOption shape', () => {
  it.each<[string, SelectOption]>([
    ['{ value }', { value: 'daily' }],
    ['{ index }', { index: 0 }],
  ])('hands %s to the engine unchanged', async (_, value) => {
    const { select, performed } = selectScreen();
    await select.selectOption(value);
    expect(performed).toEqual([{ kind: 'selectOption', value }]);
  });

  it('rejects an array of options before the engine acts', async () => {
    const { select, performed } = selectScreen();
    await expect(select.selectOption(invalid<SelectOption>(['daily', 'weekly']))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'selectOption takes one option per call; an array of options is not supported',
    });
    expect(performed).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['two keys', { label: 'Daily', value: 'daily' }],
    ['a negative index', { index: -1 }],
    ['a label inheriting an index', Object.assign(Object.create({ index: 2 }), { label: 'Daily' })],
    ['a label beside a non-enumerable value', Object.defineProperty({ label: 'Daily' }, 'value', { value: 'weekly' })],
  ])('rejects %s before the engine acts', async (_, value) => {
    const { select, performed } = selectScreen();
    await expect(select.selectOption(invalid<SelectOption>(value))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'selectOption takes a label string or exactly one of { label }, { value }, { index } with a nonnegative integer index',
    });
    expect(performed).toEqual([]);
  });
});
