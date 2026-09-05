/**
 * LocatorExpression projection: which compositions land on Playwright's own
 * locator chain, which ones a display-value query defers until its candidates
 * are read, and which ones the backend cannot express at all.
 */

import type { Locator as PwLocator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { LocatorExpression } from '@e2edev/e2e/backend';
import { projectExpression, selectPositions } from '../../src/locators.ts';

/** A chain-recording stand-in for a Playwright locator. */
interface FakeLocator {
  readonly chain: readonly string[];
}

function fakeLocator(chain: readonly string[]): PwLocator {
  const self = {
    chain,
    locator: (selector: string) => fakeLocator([...chain, `locator(${selector})`]),
    getByRole: (role: string) => fakeLocator([...chain, `role(${role})`]),
    filter: (options: { hasText?: string | RegExp; has?: PwLocator }) =>
      fakeLocator([
        ...chain,
        `filter(${[
          options.hasText === undefined ? '' : `hasText=${String(options.hasText)}`,
          options.has === undefined ? '' : `has=${chainOf(options.has).join('>')}`,
        ]
          .filter((part) => part !== '')
          .join(',')})`,
      ]),
    first: () => fakeLocator([...chain, 'first']),
    last: () => fakeLocator([...chain, 'last']),
    nth: (index: number) => fakeLocator([...chain, `nth(${String(index)})`]),
  };
  return self as unknown as PwLocator;
}

function chainOf(locator: PwLocator): readonly string[] {
  return (locator as unknown as FakeLocator).chain;
}

const page = fakeLocator([]) as unknown as Page;

const shared: LocatorExpression = {
  kind: 'query',
  query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
};
const textbox: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
};

describe('projectExpression', () => {
  it('composes positions natively for every query but displayValue', () => {
    const projected = projectExpression(page, { kind: 'index', source: textbox, index: 1 });
    expect(chainOf(projected.locator)).toEqual(['role(textbox)', 'nth(1)']);
    expect(projected.displayValue).toBeNull();
    expect(projected.positions).toEqual([]);
  });

  it('defers positions on a displayValue query until its candidates are value-filtered', () => {
    const projected = projectExpression(page, {
      kind: 'index',
      source: { kind: 'index', source: shared, index: 'last' },
      index: 'first',
    });
    expect(chainOf(projected.locator)).toEqual(['locator(input, textarea, select)']);
    expect(projected.displayValue).toEqual({ kind: 'string', value: 'shared', exact: true });
    expect(projected.positions).toEqual(['last', 'first']);
  });

  it('composes per-element filters onto the displayValue candidate locator', () => {
    const projected = projectExpression(page, {
      kind: 'index',
      source: { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'x', exact: false }, has: textbox },
      index: 0,
    });
    expect(chainOf(projected.locator)).toEqual([
      'locator(input, textarea, select)',
      'filter(hasText=x,has=role(textbox))',
    ]);
    expect(projected.displayValue).not.toBeNull();
    expect(projected.positions).toEqual([0]);
  });

  it('rejects a displayValue query as a scope or has-filter, and names only those cases', () => {
    const message = 'displayValue queries cannot scope child queries or serve as a has-filter in this backend';
    expect(() => projectExpression(page, { ...textbox, scope: shared })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message }),
    );
    expect(() => projectExpression(page, { kind: 'filter', source: textbox, has: shared })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message }),
    );
  });

  it('rejects a filter placed after a position on a displayValue query', () => {
    expect(() =>
      projectExpression(page, {
        kind: 'filter',
        source: { kind: 'index', source: shared, index: 'first' },
        hasText: { kind: 'string', value: 'x', exact: false },
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
});

describe('selectPositions', () => {
  const matches = ['a', 'b', 'c'];

  it.each([
    [['first'], ['a']],
    [['last'], ['c']],
    [[1], ['b']],
    [[3], []],
    [['last', 'first'], ['c']],
    [[1, 'last'], ['b']],
    [[], ['a', 'b', 'c']],
  ] as const)('applies %j to yield %j', (positions, expected) => {
    expect(selectPositions(matches, positions)).toEqual(expected);
  });
});
