import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from '@e2edev/e2e/engine';
import { resolveExpression } from '../../src/locate.ts';
import { projectSnapshot } from '../../src/nodes.ts';
import { SETTINGS_NODES } from '../helpers/fake-client.ts';

const OPTIONS = { testIdAttribute: 'data-testid' };

function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

function query(kind: 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId', value: string, extra: object = {}): LocatorExpression {
  return { kind: 'query', query: { kind, value: exact(value), ...extra } };
}

function names(expression: LocatorExpression): string[] {
  let counter = 0;
  const { index } = projectSnapshot(SETTINGS_NODES, {
    testIdAttribute: 'data-testid',
    mintId: () => `n${++counter}`,
  });
  return resolveExpression(expression, index, OPTIONS).map((entry) => entry.node.name ?? '');
}

describe('locator expressions over a device snapshot', () => {
  it('answers role queries with name filters and skips hidden nodes unless asked', () => {
    expect(names(query('role', 'button'))).toEqual(['Back']);
    expect(names(query('role', 'button', { states: { hidden: true } }))).toEqual(['Back', 'Hidden']);
    expect(names(query('role', 'button', { name: exact('Back') }))).toEqual(['Back']);
    expect(names(query('role', 'button', { name: { kind: 'regexp', source: '^ba', flags: 'i' } }))).toEqual(['Back']);
    expect(names(query('role', 'switch', { states: { checked: true } }))).toEqual([]);
    expect(names(query('role', 'switch', { states: { checked: false } }))).toEqual(['Airplane Mode']);
  });

  it('drops hidden nodes from any query kind when it says visible', () => {
    expect(names(query('text', 'Hidden'))).toEqual(['Hidden']);
    expect(names(query('text', 'Hidden', { visible: true }))).toEqual([]);
    expect(names(query('role', 'button', { states: { hidden: true }, visible: true }))).toEqual(['Back']);
    expect(names(query('label', 'Search', { visible: true }))).toEqual(['Search']);
    expect(names({ kind: 'index', source: query('text', 'About', { visible: true }), index: 'last' })).toEqual(['About']);
  });

  it('answers label, text, display value, and test id queries', () => {
    expect(names(query('label', 'Search'))).toEqual(['Search']);
    expect(names(query('text', 'About'))).toEqual(['About', 'About']);
    expect(names({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'abo', exact: false } } })).toEqual([
      'About',
      'About',
    ]);
    expect(names(query('displayValue', 'wifi'))).toEqual(['Search']);
    expect(names(query('displayValue', 'hunter2'))).toEqual([]);
    expect(names(query('testId', 'ABOUT'))).toEqual(['About']);
    expect(names(query('placeholder', 'anything'))).toEqual([]);
  });

  it('scopes, filters, and indexes', () => {
    const inBar: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('button') },
      scope: query('role', 'navigation'),
    };
    expect(names(inBar)).toEqual(['Back']);
    const cellsWithAbout: LocatorExpression = { kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') };
    expect(names(cellsWithAbout)).toEqual(['About']);
    const cellsHavingText: LocatorExpression = { kind: 'filter', source: query('role', 'listitem'), has: query('role', 'text') };
    expect(names(cellsHavingText)).toEqual(['About']);
    expect(names({ kind: 'index', source: query('role', 'listitem'), index: 'last' })).toEqual(['Scroller']);
    expect(names({ kind: 'index', source: query('role', 'listitem'), index: 5 })).toEqual([]);
  });

  it('resolves agent-device selectors, alternatives first-match, and rejects frames', () => {
    expect(names({ kind: 'selector', selector: 'id=ABOUT' })).toEqual(['About']);
    expect(names({ kind: 'selector', selector: 'role=button visible' })).toEqual(['Back']);
    expect(names({ kind: 'selector', selector: 'role=cell' })).toEqual(['About', 'Scroller']);
    expect(names({ kind: 'selector', selector: 'role=Cell' })).toEqual(['About', 'Scroller']);
    expect(names({ kind: 'selector', selector: 'role=NavigationBar' })).toEqual(['General']);
    expect(names({ kind: 'selector', selector: 'role=navigation' })).toEqual(['General']);
    expect(names({ kind: 'selector', selector: 'label="Airplane Mode" role=switch' })).toEqual(['Airplane Mode']);
    expect(names({ kind: 'selector', selector: 'editable' })).toEqual(['Search', 'Password']);
    expect(names({ kind: 'selector', selector: 'enabled=false' })).toEqual(['Hidden']);
    expect(() => names({ kind: 'selector', selector: '@e3' })).toThrow(/invalid agent-device selector/);
    expect(() => names({ kind: 'frame', selector: 'iframe', source: query('role', 'button') })).toThrowError(
      expect.objectContaining({ code: 'FRAME_NOT_FOUND' }),
    );
  });
});
