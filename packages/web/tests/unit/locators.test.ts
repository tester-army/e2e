/**
 * LocatorExpression projection: which compositions land on Playwright's own
 * locator chain, which ones a display-value query defers until its candidates
 * are read, and which ones the engine cannot express at all.
 */

import type { Locator as PwLocator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from 'e2e/engine';
import { applyPostSteps, projectExpression as projectWith, type PostStep } from '../../src/locators.ts';

/** A chain-recording stand-in for a Playwright locator. */
interface FakeLocator {
  readonly chain: readonly string[];
}

function fakeLocator(chain: readonly string[]): PwLocator {
  const self = {
    chain,
    locator: (selector: string) => fakeLocator([...chain, `locator(${selector})`]),
    getByRole: (role: string, options?: Record<string, unknown>) =>
      fakeLocator([
        ...chain,
        `role(${role}${options === undefined || Object.keys(options).length === 0 ? '' : `,${JSON.stringify(options)}`})`,
      ]),
    getByLabel: (text: string | RegExp, options?: { exact?: boolean }) =>
      fakeLocator([...chain, `label(${String(text)}${options?.exact ? ',exact' : ''})`]),
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

/** Projects with the default test-id attribute; the attribute itself is exercised in its own case. */
const projectExpression = (target: Page, expression: LocatorExpression) => projectWith(target, expression, 'data-testid');

const shared: LocatorExpression = {
  kind: 'query',
  query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
};
const textbox: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
};

describe('projectExpression', () => {
  it('projects an exact label query onto labelable candidates with a label predicate, and composes loosely', () => {
    const label: LocatorExpression = {
      kind: 'query',
      query: { kind: 'label', value: { kind: 'string', value: 'Display name', exact: true } },
    };
    const projected = projectExpression(page, label);
    expect(projected.name).toEqual({ kind: 'string', value: 'Display name', exact: true });
    expect(chainOf(projected.locator)).toEqual([
      'locator(button, input:not([type="hidden"]), textarea, select, meter, output, progress, [aria-label], [aria-labelledby])',
    ]);
    expect(projected.composable === null ? null : chainOf(projected.composable)).toEqual(['label(Display name)']);
    // A position waits for the predicate and also narrows the composable locator.
    const firstLabel: LocatorExpression = { kind: 'index', source: label, index: 'first' };
    const first = projectExpression(page, firstLabel);
    expect(first.steps).toEqual([{ kind: 'index', index: 'first' }]);
    expect(first.composable === null ? null : chainOf(first.composable)).toEqual(['label(Display name)', 'first']);
    const scoped = projectExpression(page, { ...textbox, scope: firstLabel } as LocatorExpression);
    expect(chainOf(scoped.locator)).toEqual(['label(Display name)', 'first', 'role(textbox)']);
    // A substring label query keeps Playwright's own matching.
    const loose = projectExpression(page, {
      kind: 'query',
      query: { kind: 'label', value: { kind: 'string', value: 'Display', exact: false } },
    });
    expect(loose.name).toBeNull();
  });

  it('projects a testId query onto the configured attribute, encoded as getByTestId encodes it', () => {
    const testId = (value: TextPattern): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'testId', value },
    });
    const exact = projectWith(page, testId({ kind: 'string', value: 'save "draft"', exact: true }), 'data-qa');
    expect(chainOf(exact.locator)).toEqual(['locator(internal:testid=[data-qa="save \\"draft\\""s])']);
    // A string is always an exact match, whatever `exact` says: getByTestId has no substring mode.
    const loose = projectWith(page, testId({ kind: 'string', value: 'save', exact: false }), 'data-qa');
    expect(chainOf(loose.locator)).toEqual(['locator(internal:testid=[data-qa="save"s])']);
    const pattern = projectWith(page, testId({ kind: 'regexp', source: '^row-\\d+$', flags: 'i' }), 'data-test-id');
    expect(chainOf(pattern.locator)).toEqual(['locator(internal:testid=[data-test-id=/^row-\\d+$/i])']);
    // An attribute with a comma is quoted, as Playwright quotes it.
    const quoted = projectWith(page, testId({ kind: 'string', value: 'x', exact: true }), 'a,b');
    expect(chainOf(quoted.locator)).toEqual(['locator(internal:testid=["a,b"="x"s])']);
  });

  it('passes role states and the heading level through to getByRole', () => {
    const heading: LocatorExpression = {
      kind: 'query',
      query: {
        kind: 'role',
        value: { kind: 'string', value: 'heading', exact: true },
        name: { kind: 'string', value: 'Dashboard', exact: true },
        level: 1,
      },
    };
    expect(chainOf(projectExpression(page, heading).locator)).toEqual(['role(heading,{"name":"Dashboard","exact":true,"level":1})']);
    const checkbox: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: true, disabled: false } },
    };
    expect(chainOf(projectExpression(page, checkbox).locator)).toEqual(['role(checkbox,{"checked":true,"disabled":false})']);
  });

  it('spells the contract image role as the img role the selector knows', () => {
    const image: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'image', exact: true }, name: { kind: 'string', value: 'Map', exact: true } },
    };
    expect(chainOf(projectExpression(page, image).locator)).toEqual(['role(img,{"name":"Map","exact":true})']);
    const tablist: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'tablist', exact: true } },
    };
    expect(chainOf(projectExpression(page, tablist).locator)).toEqual(['role(tablist)']);
  });

  it('composes positions natively for every query but displayValue', () => {
    const projected = projectExpression(page, { kind: 'index', source: textbox, index: 1 });
    expect(chainOf(projected.locator)).toEqual(['role(textbox)', 'nth(1)']);
    expect(projected.displayValue).toBeNull();
    expect(projected.steps).toEqual([]);
  });

  it('defers positions on a displayValue query until its candidates are value-filtered', () => {
    const projected = projectExpression(page, {
      kind: 'index',
      source: { kind: 'index', source: shared, index: 'last' },
      index: 'first',
    });
    expect(chainOf(projected.locator)).toEqual(['locator(input, textarea, select)']);
    expect(projected.displayValue).toEqual({ kind: 'string', value: 'shared', exact: true });
    expect(projected.steps).toEqual([
      { kind: 'index', index: 'last' },
      { kind: 'index', index: 'first' },
    ]);
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
    expect(projected.steps).toEqual([{ kind: 'index', index: 0 }]);
  });

  it('rejects a displayValue query as a scope or has-filter, and names only those cases', () => {
    const message = 'displayValue queries cannot scope child queries or serve as a has-filter in this engine';
    expect(() => projectExpression(page, { ...textbox, scope: shared })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message }),
    );
    expect(() => projectExpression(page, { kind: 'filter', source: textbox, has: shared })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message }),
    );
  });

  it('defers a filter placed after a position on a displayValue query to the selected element', () => {
    const projected = projectExpression(page, {
      kind: 'filter',
      source: { kind: 'index', source: shared, index: 'first' },
      hasText: { kind: 'string', value: 'x', exact: false },
      has: textbox,
    });
    expect(chainOf(projected.locator)).toEqual(['locator(input, textarea, select)']);
    expect(projected.steps).toHaveLength(2);
    expect(projected.steps[0]).toEqual({ kind: 'index', index: 'first' });
    const filter = projected.steps[1]!;
    expect(filter.kind).toBe('filter');
    if (filter.kind !== 'filter') return;
    expect(filter.options.hasText).toBe('x');
    expect(chainOf(filter.options.has!)).toEqual(['role(textbox)']);
  });

  it('still rejects a displayValue has-filter after a position', () => {
    expect(() =>
      projectExpression(page, {
        kind: 'filter',
        source: { kind: 'index', source: textbox, index: 'first' },
        has: shared,
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
});

describe('applyPostSteps', () => {
  const matches = ['a', 'b', 'c'];
  const index = (value: 'first' | 'last' | number): PostStep => ({ kind: 'index', index: value });
  const never = () => Promise.resolve(false);

  it.each([
    [[index('first')], ['a']],
    [[index('last')], ['c']],
    [[index(1)], ['b']],
    [[index(3)], []],
    [[index('last'), index('first')], ['c']],
    [[index(1), index('last')], ['b']],
    [[], ['a', 'b', 'c']],
  ] as const)('applies %j to yield %j', async (steps, expected) => {
    expect(await applyPostSteps(matches, steps, never)).toEqual(expected);
  });

  it('runs a filter step only on the matches the steps before it selected', async () => {
    const asked: string[] = [];
    const filter: PostStep = { kind: 'filter', options: { hasText: 'x' } };
    const kept = await applyPostSteps(matches, [index('last'), filter], async (match, options) => {
      asked.push(`${match}:${String(options.hasText)}`);
      return match === 'c';
    });
    expect(kept).toEqual(['c']);
    expect(asked).toEqual(['c:x']);
    expect(await applyPostSteps(matches, [index('first'), filter], never)).toEqual([]);
  });
});
