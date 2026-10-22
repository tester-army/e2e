/**
 * `screen.tree` and `screen.debug`: one observation of the whole screen,
 * rendered the way the agent reads it, as a screen step. Scoped screens and
 * locators refuse, since the tree is never scoped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticNode } from '../../src/engine/index.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const LIST: SemanticNode = {
  ref: { id: 'list', revision: '' },
  role: 'list',
  name: 'Todos',
  children: [{ ref: { id: 'milk', revision: '' }, role: 'checkbox', name: 'Milk', states: { checked: true } }],
};
const ADD: SemanticNode = { ref: { id: 'add', revision: '' }, role: 'button', name: 'Add' };

function todoScreen() {
  const observe = vi.fn(() => snapshot([LIST, ADD]));
  return { ...screenOver({ locate: () => [ADD], observe, timeoutMs: 2_000 }), observe };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('screen.tree', () => {
  it('renders one observation, children indented, as a screen step', async () => {
    const { screen, steps, observe } = todoScreen();
    const tree = await screen.tree();
    expect(tree.split('\n')).toEqual([
      expect.stringMatching(/^#root root/),
      expect.stringMatching(/^ #list list "Todos"/),
      expect.stringMatching(/^ {2}#milk checkbox "Milk" \[checked\]/),
      expect.stringMatching(/^ #add button "Add"/),
    ]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(steps.all()).toEqual([expect.objectContaining({ kind: 'screen', api: 'screen.tree', status: 'passed' })]);
  });

  it('refuses on a locator, before observing', async () => {
    const { screen, observe } = todoScreen();
    const locator = screen.getByRole('list') as unknown as { tree(): Promise<string> };
    await expect(locator.tree()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(observe).not.toHaveBeenCalled();
  });

  it('refuses an unknown option', async () => {
    const { screen } = todoScreen();
    await expect(screen.tree({ depth: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('screen.debug', () => {
  it('prints the tree to the test output', async () => {
    const { screen, steps } = todoScreen();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await screen.debug();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(await screen.tree());
    expect(steps.all()[0]).toMatchObject({ kind: 'screen', api: 'screen.debug', status: 'passed' });
  });
});
