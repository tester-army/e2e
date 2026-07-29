import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from '../../src/driver/index.ts';
import {
  matchesPattern,
  normalizeText,
  resolveExpression,
} from '../../src/agent-device/locators.ts';
import { projectSnapshot } from '../../src/agent-device/snapshot.ts';
import { buildSnapshot, loginSnapshot } from '../helpers/mobile-snapshot.ts';

const exact = (value: string): TextPattern => ({ kind: 'string', value, exact: true });
const loose = (value: string): TextPattern => ({ kind: 'string', value, exact: false });

function refs(snapshot: ReturnType<typeof buildSnapshot>, expression: LocatorExpression): string[] {
  const projected = projectSnapshot(snapshot, 'ios', 'r1');
  return resolveExpression(projected, expression).map((node) => node.ref);
}

describe('normalizeText', () => {
  it('trims and collapses Unicode whitespace runs to one space', () => {
    expect(normalizeText('  Sign\u00a0\u00a0 in \n')).toBe('Sign in');
  });
});

describe('matchesPattern', () => {
  it('matches a string exactly by default and as a substring when inexact', () => {
    expect(matchesPattern('Sign in', exact('Sign in'))).toBe(true);
    expect(matchesPattern('Sign in', exact('Sign'))).toBe(false);
    expect(matchesPattern('Sign in', loose('sign'))).toBe(true);
  });

  it('applies regexp source and flags and ignores exact', () => {
    expect(matchesPattern('Sign in', { kind: 'regexp', source: '^sign', flags: 'i' })).toBe(true);
    expect(matchesPattern('Sign in', { kind: 'regexp', source: '^sign', flags: '' })).toBe(false);
  });

  it('resets global regexp state between candidates', () => {
    const pattern: TextPattern = { kind: 'regexp', source: 'a', flags: 'g' };
    expect(matchesPattern('a', pattern)).toBe(true);
    expect(matchesPattern('a', pattern)).toBe(true);
  });

  it('never matches an absent candidate', () => {
    expect(matchesPattern(undefined, loose(''))).toBe(false);
  });
});

describe('resolveExpression', () => {
  it('resolves each query kind against its mobile source', () => {
    const snapshot = loginSnapshot();
    expect(refs(snapshot, { kind: 'query', query: { kind: 'role', value: exact('button') } })).toEqual(
      ['@e6'],
    );
    expect(refs(snapshot, { kind: 'query', query: { kind: 'label', value: exact('Email') } })).toEqual(
      ['@e4'],
    );
    expect(refs(snapshot, { kind: 'query', query: { kind: 'testId', value: exact('email') } })).toEqual(
      ['@e4'],
    );
    expect(
      refs(snapshot, { kind: 'query', query: { kind: 'text', value: exact('Sign in') } }),
    ).toEqual(['@e3']);
    expect(
      refs(snapshot, { kind: 'query', query: { kind: 'placeholder', value: exact('Password') } }),
    ).toEqual(['@e5']);
  });

  it('matches only the innermost carrier of a label repeated up the chain', () => {
    // Real iOS repeats a row's accessibility label on every ancestor wrapper:
    // Cell > Other > Button > StaticText all read "General".
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeCell',
        label: 'General',
        children: [
          {
            type: 'XCUIElementTypeOther',
            label: 'General',
            children: [
              {
                type: 'XCUIElementTypeButton',
                label: 'General',
                children: [{ type: 'XCUIElementTypeStaticText', label: 'General' }],
              },
            ],
          },
        ],
      },
    ]);
    expect(refs(snapshot, { kind: 'query', query: { kind: 'text', value: exact('General') } })).toEqual(
      ['@e4'],
    );
    expect(refs(snapshot, { kind: 'query', query: { kind: 'label', value: exact('General') } })).toEqual(
      ['@e4'],
    );
    // A role query still reaches the control, because the role disambiguates it.
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button'), name: exact('General') },
      }),
    ).toEqual(['@e3']);
    // hasText still sees the whole subtree, so row filtering keeps working.
    // The public API always builds hasText as a substring pattern.
    expect(
      refs(snapshot, {
        kind: 'filter',
        source: { kind: 'query', query: { kind: 'role', value: exact('listitem') } },
        hasText: loose('General'),
      }),
    ).toEqual(['@e1']);
  });

  it('keeps a composite label that no descendant repeats', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeCell',
        label: 'Apple Account, Sign in to access your data',
        children: [
          { type: 'XCUIElementTypeStaticText', label: 'Apple Account' },
          { type: 'XCUIElementTypeStaticText', label: 'Sign in to access your data' },
        ],
      },
    ]);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'text', value: exact('Apple Account, Sign in to access your data') },
      }),
    ).toEqual(['@e1']);
    expect(refs(snapshot, { kind: 'query', query: { kind: 'text', value: exact('Apple Account') } })).toEqual(
      ['@e2'],
    );
  });

  it('matches a role query name against the label', () => {
    const snapshot = loginSnapshot();
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button'), name: exact('Continue') },
      }),
    ).toEqual(['@e6']);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button'), name: exact('Cancel') },
      }),
    ).toEqual([]);
  });

  it('excludes hidden nodes unless the query asks for them', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeButton', label: 'Ghost', visibleToUser: false },
    ]);
    const query = { kind: 'role', value: exact('button') } as const;
    expect(refs(snapshot, { kind: 'query', query })).toEqual([]);
    expect(
      refs(snapshot, { kind: 'query', query: { ...query, states: { hidden: true } } }),
    ).toEqual(['@e1']);
  });

  it('filters by derived checked and by disabled state', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeSwitch', label: 'On', value: '1' },
      { type: 'XCUIElementTypeSwitch', label: 'Off', value: '0' },
      { type: 'XCUIElementTypeButton', label: 'Dim', enabled: false },
    ]);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('switch'), states: { checked: true } },
      }),
    ).toEqual(['@e1']);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button'), states: { disabled: true } },
      }),
    ).toEqual(['@e3']);
  });

  it('never matches expanded, which mobile does not support', () => {
    const snapshot = buildSnapshot([{ type: 'XCUIElementTypeButton', label: 'Menu' }]);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button'), states: { expanded: false } },
      }),
    ).toEqual([]);
  });

  it('scopes a query to descendants and excludes the scope node', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeOther',
        identifier: 'first',
        children: [{ type: 'XCUIElementTypeButton', label: 'Go' }],
      },
      {
        type: 'XCUIElementTypeOther',
        identifier: 'second',
        children: [{ type: 'XCUIElementTypeButton', label: 'Go' }],
      },
    ]);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'role', value: exact('button') },
        scope: { kind: 'query', query: { kind: 'testId', value: exact('second') } },
      }),
    ).toEqual(['@e4']);
    expect(
      refs(snapshot, {
        kind: 'query',
        query: { kind: 'testId', value: exact('first') },
        scope: { kind: 'query', query: { kind: 'testId', value: exact('first') } },
      }),
    ).toEqual([]);
  });

  it('applies hasText and has filters conjunctively', () => {
    const snapshot = buildSnapshot([
      {
        type: 'XCUIElementTypeCell',
        children: [
          { type: 'XCUIElementTypeStaticText', label: 'Alice' },
          { type: 'XCUIElementTypeButton', label: 'Remove' },
        ],
      },
      {
        type: 'XCUIElementTypeCell',
        children: [{ type: 'XCUIElementTypeStaticText', label: 'Bob' }],
      },
    ]);
    const cells: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('listitem') },
    };
    expect(refs(snapshot, { kind: 'filter', source: cells, hasText: loose('alice') })).toEqual([
      '@e1',
    ]);
    expect(
      refs(snapshot, {
        kind: 'filter',
        source: cells,
        has: { kind: 'query', query: { kind: 'role', value: exact('button') } },
      }),
    ).toEqual(['@e1']);
    expect(
      refs(snapshot, {
        kind: 'filter',
        source: cells,
        hasText: loose('bob'),
        has: { kind: 'query', query: { kind: 'role', value: exact('button') } },
      }),
    ).toEqual([]);
  });

  it('rejects an empty filter', () => {
    const snapshot = loginSnapshot();
    expect(() =>
      refs(snapshot, {
        kind: 'filter',
        source: { kind: 'query', query: { kind: 'role', value: exact('button') } },
      }),
    ).toThrow(/filter requires hasText or has/);
  });

  it('resolves first, last, and nth with an out-of-range index as no match', () => {
    const snapshot = buildSnapshot([
      { type: 'XCUIElementTypeButton', label: 'One' },
      { type: 'XCUIElementTypeButton', label: 'Two' },
      { type: 'XCUIElementTypeButton', label: 'Three' },
    ]);
    const source: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('button') },
    };
    expect(refs(snapshot, { kind: 'index', source, index: 'first' })).toEqual(['@e1']);
    expect(refs(snapshot, { kind: 'index', source, index: 'last' })).toEqual(['@e3']);
    expect(refs(snapshot, { kind: 'index', source, index: 1 })).toEqual(['@e2']);
    expect(refs(snapshot, { kind: 'index', source, index: 9 })).toEqual([]);
  });

  it('rejects a negative index', () => {
    const snapshot = loginSnapshot();
    expect(() =>
      refs(snapshot, {
        kind: 'index',
        source: { kind: 'query', query: { kind: 'role', value: exact('button') } },
        index: -1,
      }),
    ).toThrow(/negative locator index/);
  });

  it('rejects web selectors and frames as unsupported', () => {
    const snapshot = loginSnapshot();
    expect(() => refs(snapshot, { kind: 'web-selector', selector: '.btn' })).toThrow(
      /does not support CSS selectors/,
    );
    expect(() =>
      refs(snapshot, {
        kind: 'frame',
        selector: 'iframe',
        source: { kind: 'query', query: { kind: 'role', value: exact('button') } },
      }),
    ).toThrow(/does not support frames/);
  });
});
