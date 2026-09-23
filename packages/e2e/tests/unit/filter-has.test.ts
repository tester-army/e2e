/**
 * `locator.filter({ has })`: core builds one filter expression with the inner
 * locator's expression under `has` and hands it to the engine unchanged; the
 * engine decides which matches keep it. The fake engine here resolves with
 * the contract's reference semantics, where `has` is matched inside each
 * candidate's subtree, so the reads on the filtered locator are exercised
 * end to end.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type LocatorExpression, type SemanticNode } from '../../src/engine/index.ts';
import { roleQuery } from '../../src/locator/expression.ts';
import type { Locator } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const REMOVE: SemanticNode = { ref: { id: 'remove', revision: '' }, role: 'button', name: 'Remove' };
const NOTE: SemanticNode = { ref: { id: 'note', revision: '' }, role: 'text', text: 'Read only' };
const ALPHA: SemanticNode = { ref: { id: 'alpha', revision: '' }, role: 'listitem', text: 'Alpha', children: [REMOVE] };
const BETA: SemanticNode = { ref: { id: 'beta', revision: '' }, role: 'listitem', text: 'Beta', children: [NOTE] };
const ITEMS: readonly SemanticNode[] = [ALPHA, BETA];

/** A screen over the two items, logging every expression it is asked to locate. */
function listScreen() {
  const expressions: LocatorExpression[] = [];
  const { screen } = screenOver({
    observe: () => snapshot(ITEMS),
    locate: (expression) => {
      expressions.push(expression);
      return resolveExpression(expression, ITEMS);
    },
    timeoutMs: 300,
  });
  return { screen, expressions };
}

describe('locator.filter({ has })', () => {
  it('hands the engine one filter expression with the inner locator under has, unchanged', async () => {
    const { screen, expressions } = listScreen();
    await screen.getByRole('listitem').filter({ has: screen.getByRole('button', { name: 'Remove' }) }).count();
    expect(expressions).toEqual([
      {
        kind: 'filter',
        source: roleQuery('listitem', undefined, undefined),
        has: roleQuery('button', { name: 'Remove' }, undefined),
      },
    ]);
  });

  it('keeps a match whose subtree holds the inner locator and drops one that does not', async () => {
    const { screen } = listScreen();
    const items = screen.getByRole('listitem');
    const removable = items.filter({ has: screen.getByRole('button', { name: 'Remove' }) });
    expect(await removable.count()).toBe(1);
    expect(await removable.textContent()).toBe('Alpha');
    expect(await items.filter({ has: screen.getByText('Read only') }).allTextContents()).toEqual(['Beta']);
    expect(await items.filter({ has: screen.getByRole('link') }).count()).toBe(0);
  });

  it('names the whole chain when a filtered read finds nothing', async () => {
    const { screen } = listScreen();
    await expect(
      screen.getByRole('listitem').filter({ has: screen.getByRole('link') }).textContent(),
    ).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('getByRole("listitem").filter({ has: getByRole("link") })'),
    });
  });

  it('refuses a has that is not an e2e locator before any engine call', () => {
    const { screen, expressions } = listScreen();
    expect(() => screen.getByRole('listitem').filter({ has: invalid<Locator>({}) })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
    expect(expressions).toEqual([]);
  });
});
