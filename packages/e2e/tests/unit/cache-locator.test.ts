/** Cacheable locator projection (spec 10-determinism.md, CACHE-LOCATE-001). */

import { describe, expect, it } from 'vitest';
import {
  MAX_REGEXP_SOURCE_BYTES,
  toCacheLocator,
  toSemanticIdentity,
  validateRegexp,
} from '../../src/cache/index.ts';
import type { LocatorExpression, SemanticNode, TextPattern } from '../../src/driver/index.ts';
import {
  filterExpression,
  frameExpression,
  indexExpression,
  roleQuery,
  webSelectorExpression,
} from '../../src/locator/expression.ts';

/** A text-family query built directly, to keep projection cases explicit. */
function patternQuery(value: TextPattern): LocatorExpression {
  return { kind: 'query', query: { kind: 'text', value } };
}

function regexpQuery(source: string, flags: string): LocatorExpression {
  return patternQuery({ kind: 'regexp', source, flags });
}

function projected(expression: LocatorExpression) {
  const result = toCacheLocator(expression);
  if (!result.ok) throw new Error(`expected a cacheable locator, got: ${result.reason}`);
  return result.value;
}

function rejection(expression: LocatorExpression): string {
  const result = toCacheLocator(expression);
  if (result.ok) throw new Error('expected the locator to be rejected');
  return result.reason;
}

describe('semantic locators project', () => {
  it('keeps a role query with its name', () => {
    expect(projected(roleQuery('button', { name: 'Buy' }, undefined))).toEqual({
      kind: 'query',
      query: {
        kind: 'role',
        value: { kind: 'string', value: 'button', exact: true },
        name: { kind: 'string', value: 'Buy', exact: true },
      },
    });
  });

  it('keeps nested filters and indexes', () => {
    const expression = indexExpression(
      filterExpression(roleQuery('listitem', undefined, undefined), { hasText: 'Pro plan' }),
      'first',
    );
    expect(projected(expression)).toMatchObject({
      kind: 'index',
      index: 'first',
      source: { kind: 'filter', source: { kind: 'query' } },
    });
  });
});

describe('non-semantic locators are refused', () => {
  it('refuses a raw web selector', () => {
    expect(rejection(webSelectorExpression('#buy'))).toContain('selector');
  });

  it('refuses a frame chain, which is addressed by CSS selector', () => {
    // An iframe-scoped locate is a bypass in v0: cache-1 has no frame node and
    // forbids storing a CSS selector.
    expect(
      rejection(frameExpression('iframe#pay', roleQuery('textbox', undefined, undefined))),
    ).toContain('frame');
  });

  it('refuses a selector nested anywhere in the tree', () => {
    const nested = filterExpression(roleQuery('listitem', undefined, undefined), {
      has: webSelectorExpression('.sold-out'),
    });
    expect(rejection(nested)).toContain('selector');
    expect(
      rejection(
        indexExpression(frameExpression('iframe', roleQuery('button', undefined, undefined)), 0),
      ),
    ).toContain('frame');
  });

  it('refuses a filter that constrains nothing', () => {
    expect(
      rejection({ kind: 'filter', source: roleQuery('listitem', undefined, undefined) }),
    ).toContain('constrain');
  });

  it('refuses a negative index', () => {
    expect(rejection({ kind: 'index', source: roleQuery('listitem', undefined, undefined), index: -1 })).toContain(
      'negative',
    );
  });
});

describe('regexp ceilings', () => {
  it('accepts a canonical pattern', () => {
    expect(validateRegexp('^Buy', 'i')).toBeUndefined();
    expect(projected(regexpQuery('^Buy$', 'i'))).toMatchObject({
      query: { value: { kind: 'regexp', source: '^Buy$', flags: 'i' } },
    });
  });

  it('refuses a source over the byte cap', () => {
    const oversized = 'a'.repeat(MAX_REGEXP_SOURCE_BYTES + 1);
    expect(validateRegexp(oversized, '')).toContain('over the');
    expect(rejection(regexpQuery(oversized, ''))).toContain('over the');
  });

  it('measures the cap in UTF-8 bytes, not code units', () => {
    // Four bytes per emoji, so a quarter of the cap plus one exceeds it.
    const wide = '\u{1F600}'.repeat(MAX_REGEXP_SOURCE_BYTES / 4 + 1);
    expect(validateRegexp(wide, '')).toContain('over the');
  });

  it('refuses mutually exclusive u and v flags', () => {
    expect(validateRegexp('a', 'uv')).toContain('mutually exclusive');
  });

  it('refuses non-canonical flag order on read', () => {
    expect(validateRegexp('a', 'ig')).toContain('canonical order');
  });

  it('normalizes flag order on write', () => {
    expect(projected(regexpQuery('a', 'ig'))).toMatchObject({
      query: { value: { flags: 'gi' } },
    });
  });
});

describe('expected semantic identity', () => {
  function node(overrides: Partial<SemanticNode> = {}): SemanticNode {
    return { ref: { id: 'n1', revision: 'r1' }, role: 'button', ...overrides } as SemanticNode;
  }

  it('records role, normalized name, and stable states', () => {
    const result = toSemanticIdentity(
      node({ name: '  Buy \n now ', states: { checked: false, disabled: false } }),
    );
    expect(result).toEqual({
      ok: true,
      value: { role: 'button', name: 'Buy now', states: { checked: false, disabled: false } },
    });
  });

  it('omits focus and secure state, which are not identity', () => {
    const result = toSemanticIdentity(node({ states: { focused: true, secure: true } }));
    expect(result.ok && result.value.states).toBeUndefined();
  });

  it('refuses a node with no explicit role', () => {
    const roleless = { ref: { id: 'n1', revision: 'r1' } } as SemanticNode;
    expect(toSemanticIdentity(roleless).ok).toBe(false);
  });
});
