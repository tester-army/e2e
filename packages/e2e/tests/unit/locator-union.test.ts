/**
 * `locator.or(other)`: core builds one union expression and the engine
 * resolves it. The fake engine here resolves with the contract's reference
 * semantics: matches of either branch in traversal order, each node once.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type LocatorExpression, type SemanticNode } from '../../src/engine/index.ts';
import type { Locator } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const TABS: readonly SemanticNode[] = [
  { ref: { id: 'discover', revision: '' }, role: 'tab', name: 'Discover', text: 'Discover' },
  { ref: { id: 'odkrywaj', revision: '' }, role: 'tab', name: 'Odkrywaj', text: 'Odkrywaj' },
];

/** A screen over the two tabs, logging every expression it is asked to locate. */
function tabScreen() {
  const expressions: LocatorExpression[] = [];
  const { screen } = screenOver({
    observe: () => snapshot(TABS),
    locate: (expression) => {
      expressions.push(expression);
      return resolveExpression(expression, TABS);
    },
    timeoutMs: 50,
  });
  return { screen, expressions };
}

describe('locator.or', () => {
  it('keeps traversal order over branch order and counts an overlapping node once', async () => {
    const { screen } = tabScreen();
    const discover = screen.getByRole('tab', { name: 'Discover' });
    const odkrywaj = screen.getByRole('tab', { name: 'Odkrywaj' });
    expect(await odkrywaj.or(discover).allTextContents()).toEqual(['Discover', 'Odkrywaj']);
    expect(await discover.or(discover).count()).toBe(1);
    expect(await odkrywaj.or(discover).first().textContent()).toBe('Discover');
  });

  it('stays strict when both branches match, naming both in the error', async () => {
    const { screen } = tabScreen();
    const either = screen.getByRole('tab', { name: 'Discover' }).or(screen.getByRole('tab', { name: 'Odkrywaj' }));
    await expect(either.textContent()).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
      message: expect.stringContaining('getByRole("tab", name: "Discover").or(getByRole("tab", name: "Odkrywaj"))'),
    });
  });

  it('composes with filter and matches nothing when neither branch does', async () => {
    const { screen } = tabScreen();
    expect(await screen.getByRole('link').or(screen.getByRole('tab')).filter({ hasText: 'Discover' }).count()).toBe(1);
    expect(await screen.getByRole('link').or(screen.getByRole('button')).count()).toBe(0);
  });

  it("refuses another screen's locator or a non-locator before any engine call", () => {
    const left = tabScreen();
    const right = tabScreen();
    expect(() => left.screen.getByRole('tab').or(right.screen.getByRole('tab'))).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
    expect(() => left.screen.getByRole('tab').or(invalid<Locator>({}))).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
    expect(left.expressions).toEqual([]);
    expect(right.expressions).toEqual([]);
  });
});
