/** The cacheable locator shape (spec 10-determinism.md, CACHE-LOCATOR-001). */

import { describe, expect, it } from 'vitest';
import { asCacheLocator, toSemanticIdentity } from '../../src/cache/index.ts';
import type { LocatorExpression, SemanticNode } from '../../src/driver/index.ts';

const exact = (value: string) => ({ kind: 'string' as const, value, exact: true });
const roleQuery = (name: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: exact('button'), name: exact(name) },
});

describe('admitted shapes survive a round trip', () => {
  it('accepts a query, optionally scoped', () => {
    expect(asCacheLocator(roleQuery('Save'))).toEqual(roleQuery('Save'));
    const scoped: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('button'), name: exact('Save') },
      scope: roleQuery('Panel'),
    };
    expect(asCacheLocator(scoped)).toEqual(scoped);
  });

  it('accepts a filter and an index', () => {
    const filtered: LocatorExpression = {
      kind: 'filter',
      source: roleQuery('Save'),
      hasText: exact('Pro'),
    };
    expect(asCacheLocator(filtered)).toEqual(filtered);
    const indexed: LocatorExpression = { kind: 'index', source: filtered, index: 0 };
    expect(asCacheLocator(indexed)).toEqual(indexed);
    for (const index of ['first', 'last'] as const) {
      expect(asCacheLocator({ kind: 'index', source: roleQuery('Save'), index })).toMatchObject({
        index,
      });
    }
  });

  it('keeps only the admitted query states', () => {
    const withStates = {
      kind: 'query',
      query: {
        kind: 'role',
        value: exact('button'),
        states: { checked: true, focused: true, nonsense: true },
      },
    };
    expect(asCacheLocator(withStates)).toMatchObject({ query: { states: { checked: true } } });
    // focused is excluded: focus moves for reasons unrelated to node identity.
    expect(asCacheLocator(withStates)).not.toMatchObject({
      query: { states: { focused: true } },
    });
  });

  it('normalizes regexp flags into canonical order', () => {
    const pattern = { kind: 'regexp', source: 'a', flags: 'gi' };
    expect(
      asCacheLocator({ kind: 'query', query: { kind: 'text', value: pattern } }),
    ).toMatchObject({ query: { value: { flags: 'gi' } } });
    expect(
      asCacheLocator({
        kind: 'query',
        query: { kind: 'text', value: { ...pattern, flags: 'ig' } },
      }),
    ).toMatchObject({ query: { value: { flags: 'gi' } } });
  });
});

describe('the security boundary', () => {
  // This is the one thing the cache must refuse. A semantic query can only
  // address something a user could perceive; a raw selector could reach nodes
  // the observation deliberately withholds.
  it('refuses a raw web selector, anywhere in the tree', () => {
    expect(asCacheLocator({ kind: 'web-selector', selector: '#pwn' })).toBeUndefined();
    expect(
      asCacheLocator({ kind: 'index', source: { kind: 'web-selector', selector: '#pwn' }, index: 0 }),
    ).toBeUndefined();
    expect(
      asCacheLocator({
        kind: 'query',
        query: { kind: 'role', value: exact('button') },
        scope: { kind: 'web-selector', selector: '#pwn' },
      }),
    ).toBeUndefined();
    expect(
      asCacheLocator({ kind: 'filter', source: roleQuery('Save'), has: { kind: 'web-selector', selector: '#x' } }),
    ).toBeUndefined();
  });

  it('refuses a frame chain, which is addressed by CSS selector', () => {
    expect(
      asCacheLocator({ kind: 'frame', selector: 'iframe', source: roleQuery('Save') }),
    ).toBeUndefined();
  });

  it('refuses an unknown kind rather than passing it through', () => {
    expect(asCacheLocator({ kind: 'eval', code: 'fetch("/x")' })).toBeUndefined();
    expect(asCacheLocator({})).toBeUndefined();
    expect(asCacheLocator(null)).toBeUndefined();
    expect(asCacheLocator([roleQuery('Save')])).toBeUndefined();
  });
});

describe('malformed input is refused, not coerced', () => {
  it('refuses an unsupported query kind', () => {
    expect(asCacheLocator({ kind: 'query', query: { kind: 'css', value: exact('a') } })).toBeUndefined();
  });

  it('refuses a pattern that is not a string or regexp', () => {
    for (const value of [exact('a').value, { kind: 'glob', value: 'a' }, { kind: 'string', value: 'a' }]) {
      expect(asCacheLocator({ kind: 'query', query: { kind: 'text', value } })).toBeUndefined();
    }
  });

  it('refuses an oversized regexp source', () => {
    const source = 'a'.repeat(1_025);
    expect(
      asCacheLocator({ kind: 'query', query: { kind: 'text', value: { kind: 'regexp', source, flags: '' } } }),
    ).toBeUndefined();
  });

  it('refuses mutually exclusive regexp flags', () => {
    expect(
      asCacheLocator({
        kind: 'query',
        query: { kind: 'text', value: { kind: 'regexp', source: 'a', flags: 'uv' } },
      }),
    ).toBeUndefined();
  });

  it('refuses a filter that constrains nothing', () => {
    expect(asCacheLocator({ kind: 'filter', source: roleQuery('Save') })).toBeUndefined();
  });

  it('refuses a negative or fractional index', () => {
    for (const index of [-1, 1.5, 'middle']) {
      expect(asCacheLocator({ kind: 'index', source: roleQuery('Save'), index })).toBeUndefined();
    }
  });
});

describe('expected identity', () => {
  const node = (overrides: Partial<SemanticNode>): SemanticNode =>
    ({ ref: { id: 'n1', revision: 'r1' }, ...overrides }) as SemanticNode;

  it('records role and normalized name', () => {
    expect(toSemanticIdentity(node({ role: 'button', name: '  Save   now\n' }))).toEqual({
      role: 'button',
      name: 'Save now',
    });
  });

  it('omits an empty name rather than storing one', () => {
    expect(toSemanticIdentity(node({ role: 'button', name: '   ' }))).toEqual({ role: 'button' });
    expect(toSemanticIdentity(node({ role: 'button' }))).toEqual({ role: 'button' });
  });

  it('refuses a node with no role to identify it by', () => {
    expect(toSemanticIdentity(node({ name: 'Save' }))).toBeUndefined();
    expect(toSemanticIdentity(node({ role: '', name: 'Save' }))).toBeUndefined();
  });
});
