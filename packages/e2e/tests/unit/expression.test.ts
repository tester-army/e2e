import { describe, expect, it } from 'vitest';
import {
  describeExpression,
  expressionHints,
  filterExpression,
  indexExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from '../../src/locator/expression.ts';

describe('locator expressions', () => {
  it('builds role queries with name and states', () => {
    const expression = roleQuery('button', { name: 'Save', checked: true }, undefined);
    expect(expression).toEqual({
      kind: 'query',
      query: {
        kind: 'role',
        value: { kind: 'string', value: 'button', exact: true },
        name: { kind: 'string', value: 'Save', exact: true },
        states: { checked: true },
      },
    });
  });

  it('rewrites the img alias to the image role before the expression is built', () => {
    expect(roleQuery('img', { name: 'Logo' }, undefined)).toEqual(roleQuery('image', { name: 'Logo' }, undefined));
    expect(roleQuery('img', undefined, undefined)).toMatchObject({
      query: { value: { kind: 'string', value: 'image', exact: true } },
    });
    expect(describeExpression(roleQuery('img', undefined, undefined))).toBe(describeExpression(roleQuery('image', undefined, undefined)));
  });

  it('carries visible: true on every query kind and drops the default', () => {
    expect(roleQuery('button', { visible: true }, undefined)).toMatchObject({ query: { visible: true } });
    expect(textQuery('text', 'Pro', { visible: true }, undefined)).toMatchObject({ query: { visible: true } });
    expect(testIdQuery('card', { visible: true }, undefined)).toMatchObject({ query: { visible: true } });
    expect(roleQuery('button', { visible: false }, undefined)).not.toHaveProperty('query.visible');
    expect(textQuery('label', 'Email', undefined, undefined)).not.toHaveProperty('query.visible');
    expect(testIdQuery('card', undefined, undefined)).not.toHaveProperty('query.visible');
  });

  it('describes a visible query so an ambiguity message shows the predicate', () => {
    expect(describeExpression(textQuery('text', 'Pro', { visible: true }, undefined))).toBe(
      'getByText("Pro", visible: true)',
    );
    expect(describeExpression(roleQuery('button', { name: 'Save', visible: true }, undefined))).toBe(
      'getByRole("button", name: "Save", visible: true)',
    );
  });

  it('scopes queries under a parent expression', () => {
    const scope = testIdQuery('card', undefined, undefined);
    const expression = textQuery('text', 'Pro', undefined, scope);
    expect(expression).toMatchObject({ kind: 'query', scope });
  });

  it('rejects empty filters', () => {
    const source = testIdQuery('card', undefined, undefined);
    expect(() => filterExpression(source, {})).toThrow(/hasText and\/or has/);
  });

  it('rejects negative and fractional nth indices', () => {
    const source = testIdQuery('card', undefined, undefined);
    expect(() => indexExpression(source, -1)).toThrow(/nonnegative/);
    expect(() => indexExpression(source, 1.5)).toThrow(/nonnegative/);
    expect(indexExpression(source, 0)).toMatchObject({ kind: 'index', index: 0 });
  });

  it('regexp text queries serialize source and flags', () => {
    const expression = textQuery('text', /pro/i, undefined, undefined);
    expect(expression).toMatchObject({
      query: { value: { kind: 'regexp', source: 'pro', flags: 'i' } },
    });
  });

  it('builds a test-id query from a string or a regexp', () => {
    expect(testIdQuery('card', undefined, undefined)).toMatchObject({
      query: { kind: 'testId', value: { kind: 'string', value: 'card', exact: true } },
    });
    const expression = testIdQuery(/^total-/i, undefined, undefined);
    expect(expression).toMatchObject({
      query: { kind: 'testId', value: { kind: 'regexp', source: '^total-', flags: 'i' } },
    });
    expect(describeExpression(expression)).toBe('getByTestId(/^total-/i)');
  });

  it('hints only a string test id, never a pattern source read as an id', () => {
    expect(expressionHints(testIdQuery('card', undefined, undefined))).toEqual({ testId: 'card' });
    expect(expressionHints(testIdQuery(/^row-\d+$/, undefined, undefined))).toEqual({});
  });

  it('describeExpression renders a readable chain', () => {
    const expression = indexExpression(
      filterExpression(roleQuery('listitem', undefined, undefined), { hasText: 'Pro' }),
      'first',
    );
    expect(describeExpression(expression)).toBe(
      'getByRole("listitem").filter({ hasText: "Pro" }).first()',
    );
  });

  it('describeExpression renders a has filter with the inner locator, after hasText when both are set', () => {
    const inner = roleQuery('button', { name: 'Remove' }, undefined);
    const source = roleQuery('listitem', undefined, undefined);
    expect(describeExpression(filterExpression(source, { has: inner }))).toBe(
      'getByRole("listitem").filter({ has: getByRole("button", name: "Remove") })',
    );
    expect(describeExpression(filterExpression(source, { hasText: 'Pro', has: inner }))).toBe(
      'getByRole("listitem").filter({ hasText: "Pro", has: getByRole("button", name: "Remove") })',
    );
  });
});
