/**
 * `locator.filter(options)` takes `hasText` and `has` and nothing else. A key
 * it does not implement (`hasNot`, `hasNotText`, `visible`) must fail the
 * call, alone or beside a supported one, rather than be dropped: dropping an
 * exclusion widens the match and the action lands on the wrong row.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type LocatorExpression, type SemanticNode } from '../../src/engine/index.ts';
import type { Locator } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const PAID: SemanticNode = { ref: { id: 'paid', revision: '' }, role: 'row', text: 'Invoice 41 Paid' };
const DUE: SemanticNode = { ref: { id: 'due', revision: '' }, role: 'row', text: 'Invoice 42 Due' };
const ROWS: readonly SemanticNode[] = [PAID, DUE];

/** A screen over the two invoice rows, logging every expression it is asked to locate. */
function invoiceScreen() {
  const expressions: LocatorExpression[] = [];
  const { screen } = screenOver({
    observe: () => snapshot(ROWS),
    locate: (expression) => {
      expressions.push(expression);
      return resolveExpression(expression, ROWS);
    },
    timeoutMs: 300,
  });
  return { screen, expressions };
}

type FilterOptions = Parameters<Locator['filter']>[0];

describe('locator.filter options', () => {
  it('keeps hasText as the only predicate when it is the only key', async () => {
    const { screen } = invoiceScreen();
    const rows = screen.getByRole('row').filter({ hasText: 'Invoice' });
    expect(await rows.allTextContents()).toEqual(['Invoice 41 Paid', 'Invoice 42 Due']);
    expect(await screen.getByRole('row').filter({ hasText: 'Due' }).textContent()).toBe('Invoice 42 Due');
  });

  it.each<[string, (paid: Locator) => object, string]>([
    ['hasNotText beside hasText', () => ({ hasText: 'Invoice', hasNotText: 'Paid' }), 'option "hasNotText"'],
    ['hasNot beside has', (paid) => ({ has: paid, hasNot: paid }), 'option "hasNot"'],
    ['visible beside hasText', () => ({ hasText: 'Invoice', visible: true }), 'option "visible"'],
    ['hasNotText alone', () => ({ hasNotText: 'Paid' }), 'option "hasNotText"'],
    ['two unknown keys', (paid) => ({ hasText: 'Invoice', hasNot: paid, hasNotText: 'Paid' }), 'options "hasNot", "hasNotText"'],
  ])('rejects %s with INVALID_LOCATOR before any engine call', (_, options, named) => {
    const { screen, expressions } = invoiceScreen();
    const paid = screen.getByText('Paid');
    expect(() => screen.getByRole('row').filter(invalid<FilterOptions>(options(paid)))).toThrow(
      expect.objectContaining({
        code: 'INVALID_LOCATOR',
        message: `filter() has no ${named}; it takes hasText and has`,
      }),
    );
    expect(expressions).toEqual([]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', [{ hasText: 'Invoice' }]],
    ['a string', 'Invoice'],
  ])('rejects %s in place of the options object', (_, options) => {
    const { screen } = invoiceScreen();
    expect(() => screen.getByRole('row').filter(invalid<FilterOptions>(options))).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR', message: 'filter() options must be a plain object' }),
    );
  });
});
