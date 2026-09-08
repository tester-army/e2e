import { describe, expect, it } from 'vitest';
import type { LocatorExpression } from '@e2edev/e2e/engine';
import { resolveExpression } from '../../src/locate.ts';
import { projectSnapshot } from '../../src/nodes.ts';
import { compileSelector, parseSelector } from '../../src/selector.ts';
import { WINDOW_STATE } from '../helpers/fake-client.ts';

let counter = 0;
const { index } = projectSnapshot(WINDOW_STATE, { testIdAttribute: 'data-testid', mintId: () => `n${(counter += 1)}` });
const options = { testIdAttribute: 'data-testid' };

const str = (value: string, exact = false) => ({ kind: 'string' as const, value, exact });
const query = (kind: 'role' | 'label' | 'text' | 'displayValue' | 'testId' | 'placeholder', value: string, extra = {}): LocatorExpression => ({
  kind: 'query',
  query: { kind, value: str(value), ...extra },
});

const names = (expression: LocatorExpression) => resolveExpression(expression, index, options).map((entry) => entry.node.name);

describe('resolveExpression', () => {
  it('answers role queries by mapped role and name, skipping hidden nodes unless asked', () => {
    expect(names(query('role', 'button'))).toEqual(['Bold']);
    // `hidden: true` includes hidden nodes rather than selecting them, as a browser's role query does.
    expect(names(query('role', 'button', { states: { hidden: true } }))).toEqual(['Bold', 'Hidden']);
    expect(names(query('role', 'textbox'))).toEqual(['Document', 'Password', 'Search']);
    expect(names(query('role', 'checkbox', { name: str('Wrap') }))).toEqual(['Wrap']);
    expect(names(query('role', 'checkbox', { states: { checked: false } }))).toEqual([]);
  });

  it('answers label, text, display value, and test id queries', () => {
    expect(names(query('label', 'Font'))).toEqual(['Font']);
    expect(names(query('text', 'Ready'))).toEqual(['Ready']);
    expect(names(query('displayValue', 'Helvetica'))).toEqual(['Font']);
    expect(names(query('testId', 'bold'))).toEqual(['Bold']);
    expect(names(query('placeholder', 'anything'))).toEqual([]);
  });

  it('scopes, filters, and indexes', () => {
    const toolbar = query('role', 'toolbar');
    expect(names({ kind: 'query', query: { kind: 'role', value: str('button') }, scope: toolbar })).toEqual(['Bold']);
    expect(names({ kind: 'filter', source: toolbar, hasText: str('Font') })).toEqual(['Toolbar']);
    expect(names({ kind: 'filter', source: toolbar, has: query('role', 'link') })).toEqual([]);
    expect(names({ kind: 'index', source: query('role', 'textbox'), index: 'last' })).toEqual(['Search']);
  });

  it('resolves platform selectors and refuses frames', () => {
    expect(names({ kind: 'selector', selector: 'role=AXButton label=Bold' })).toEqual(['Bold']);
    expect(names({ kind: 'selector', selector: 'id=bold' })).toEqual(['Bold']);
    expect(() => names({ kind: 'frame', selector: 'x', source: query('role', 'button') })).toThrow(/nested documents/);
  });
});

describe('selector grammar', () => {
  it('parses bare and quoted terms', () => {
    expect(parseSelector('role=AXButton label="Save As" enabled=true')).toEqual([
      { key: 'role', value: 'AXButton' },
      { key: 'label', value: 'Save As' },
      { key: 'enabled', value: 'true' },
    ]);
  });

  it('matches by role spelling, label, value, token, index, and states', () => {
    const matches = (selector: string) => compileSelector(selector)(index).map((entry) => entry.node.name);
    expect(matches('role=combobox')).toEqual(['Font']);
    expect(matches('role=pop-up-button')).toEqual(['Font']);
    expect(matches('value=Helvetica')).toEqual(['Font']);
    expect(matches('text=Hello')).toEqual(['Document']);
    expect(matches('token=s1:2')).toEqual(['Bold']);
    expect(matches('index=7')).toEqual(['Ready']);
    expect(matches('role=AXButton enabled=false')).toEqual(['Hidden']);
    expect(matches('checked=true')).toEqual(['Wrap']);
    expect(matches('focused=true')).toEqual(['Document']);
  });

  it('rejects unknown terms and malformed input', () => {
    expect(() => parseSelector('colour=red')).toThrow(/unknown term/);
    expect(() => parseSelector('just words')).toThrow(/expected key=value/);
    expect(() => parseSelector('   ')).toThrow(/at least one/);
    expect(() => parseSelector('label="unbalanced')).toThrow(/expected key=value|quotes/);
  });
});
