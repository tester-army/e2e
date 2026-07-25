import { describe, expect, it } from 'vitest';
import {
  describeExpression,
  filterExpression,
  indexExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from '../../src/locator/expression.js';

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

  it('propagates exact:false to the name pattern', () => {
    const expression = roleQuery('button', { name: 'save', exact: false }, undefined);
    expect(expression).toMatchObject({
      query: { name: { kind: 'string', value: 'save', exact: false } },
    });
  });

  it('scopes queries under a parent expression', () => {
    const scope = testIdQuery('card', undefined);
    const expression = textQuery('text', 'Pro', undefined, scope);
    expect(expression).toMatchObject({ kind: 'query', scope });
  });

  it('rejects empty filters', () => {
    const source = testIdQuery('card', undefined);
    expect(() => filterExpression(source, {})).toThrow(/hasText and\/or has/);
  });

  it('rejects negative and fractional nth indices', () => {
    const source = testIdQuery('card', undefined);
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

  it('describeExpression renders a readable chain', () => {
    const expression = indexExpression(
      filterExpression(roleQuery('listitem', undefined, undefined), { hasText: 'Pro' }),
      'first',
    );
    expect(describeExpression(expression)).toBe(
      'getByRole("listitem").filter({ hasText: "Pro" }).first()',
    );
  });
});
