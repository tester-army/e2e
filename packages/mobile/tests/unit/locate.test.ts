import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from 'e2e/engine';
import { resolveExpression } from '../../src/locate.ts';
import { projectSnapshot, type RawNode } from '../../src/nodes.ts';
import type { MobilePlatform } from '../../src/options.ts';
import { ANDROID_APP_PACKAGE, ANDROID_ID_NODES, SETTINGS_NODES } from '../helpers/fake-client.ts';

function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

function query(kind: 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId', value: string, extra: object = {}): LocatorExpression {
  return { kind: 'query', query: { kind, value: exact(value), ...extra } };
}

function names(expression: LocatorExpression): string[] {
  let counter = 0;
  const { index } = projectSnapshot(SETTINGS_NODES, { mintId: () => `n${++counter}` });
  return resolveExpression(expression, index, 'ios').map((entry) => entry.node.name ?? '');
}

describe('locator expressions over a device snapshot', () => {
  it('answers role queries with name filters and skips hidden nodes', () => {
    expect(names(query('role', 'button'))).toEqual(['Back']);
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
    expect(names(query('text', 'About'))).toEqual(['About']);
    expect(names({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'abo', exact: false } } })).toEqual([
      'About',
    ]);
    expect(names(query('displayValue', 'wifi'))).toEqual(['Search']);
    expect(names(query('displayValue', 'hunter2'))).toEqual([]);
    expect(names(query('testId', 'ABOUT'))).toEqual(['About']);
    expect(names(query('placeholder', 'anything'))).toEqual([]);
  });

  it('answers text and label queries with the innermost match when an ancestor echoes the text', () => {
    let counter = 0;
    const { index } = projectSnapshot(SETTINGS_NODES, { mintId: () => `n${++counter}` });
    const matches = resolveExpression(query('text', 'About'), index, 'ios');
    expect(matches.map((entry) => entry.node.role)).toEqual(['text']);
    expect(resolveExpression(query('label', 'About'), index, 'ios').map((entry) => entry.node.role)).toEqual(['text']);
    // The echoing cell still answers role queries, and filters by its subtree text.
    expect(names(query('role', 'listitem', { name: exact('About') }))).toEqual(['About']);
    expect(names({ kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') })).toEqual(['About']);
  });

  it('resolves a label query to the text field inside the host view iOS wraps a React Native input in', () => {
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { ref: '@e1', index: 0, depth: 0, type: 'Application', label: 'Benchmark' },
        { ref: '@e2', index: 1, parentIndex: 0, depth: 1, type: 'Other', label: 'Name field' },
        { ref: '@e3', index: 2, parentIndex: 1, depth: 2, type: 'TextField', label: 'Name field', value: 'Ada', identifier: 'name-input' },
        { ref: '@e4', index: 3, parentIndex: 0, depth: 1, type: 'Other', label: 'Passphrase field' },
        { ref: '@e5', index: 4, parentIndex: 3, depth: 2, type: 'SecureTextField', label: 'Passphrase field' },
      ],
      { mintId: () => `n${++counter}` },
    );
    const field = resolveExpression(query('label', 'Name field'), index, 'ios');
    expect(field.map((entry) => [entry.node.role, entry.node.testId])).toEqual([['textbox', 'name-input']]);
    const pattern: LocatorExpression = { kind: 'query', query: { kind: 'label', value: { kind: 'regexp', source: 'field$', flags: '' } } };
    expect(resolveExpression(pattern, index, 'ios').map((entry) => entry.node.role)).toEqual(['textbox', 'textbox']);
    // A role query keeps both, since the host view answers to no vocabulary role of its own.
    expect(resolveExpression(query('role', 'textbox'), index, 'ios')).toHaveLength(2);
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

  it('unions matches in traversal order without duplicates', () => {
    const back = query('role', 'button');
    const search = query('label', 'Search');
    expect(names({ kind: 'union', left: search, right: back })).toEqual(['Back', 'Search']);
    expect(names({ kind: 'union', left: back, right: back })).toEqual(['Back']);
    expect(names({ kind: 'index', source: { kind: 'union', left: search, right: back }, index: 'first' })).toEqual(['Back']);
  });

  it('routes agent-device selectors to the selector matcher, and rejects frames', () => {
    expect(names({ kind: 'selector', selector: 'id=ABOUT' })).toEqual(['About']);
    expect(names({ kind: 'selector', selector: 'id=NOPE || label="Airplane Mode"' })).toEqual(['Airplane Mode']);
    expect(() => names({ kind: 'selector', selector: '@e3' })).toThrow(/invalid agent-device selector/);
    expect(() => names({ kind: 'frame', selector: 'iframe', source: query('role', 'button') })).toThrowError(
      expect.objectContaining({ code: 'FRAME_NOT_FOUND' }),
    );
  });
});

function testIds(
  expression: LocatorExpression,
  options: { readonly platform?: MobilePlatform; readonly nodes?: readonly RawNode[] } = {},
): string[] {
  let counter = 0;
  const { index } = projectSnapshot(options.nodes ?? ANDROID_ID_NODES, { mintId: () => `n${++counter}` });
  return resolveExpression(expression, index, options.platform ?? 'android').map((entry) => entry.node.testId ?? '');
}

describe('Android resource ids without their package', () => {
  const app = ANDROID_APP_PACKAGE;

  it('finds a view by its id without the package prefix', () => {
    expect(testIds(query('testId', 'greet'))).toEqual([`${app}:id/greet`]);
  });

  it('still finds a view by its full resource id', () => {
    expect(testIds(query('testId', `${app}:id/greet`))).toEqual([`${app}:id/greet`]);
  });

  it('answers an id the app set without a prefix as before', () => {
    expect(testIds(query('testId', 'greeting'))).toEqual(['greeting']);
  });

  it('leaves the prefix off any package but the framework', () => {
    expect(testIds(query('testId', 'banner'))).toEqual(['com.example.other:id/banner']);
    expect(testIds(query('testId', 'content'))).toEqual([]);
    expect(testIds(query('testId', 'android:id/content'))).toEqual(['android:id/content']);
  });

  it('prefers a full match, so a bare id wins over a prefixed one with the same name', () => {
    const nodes: readonly RawNode[] = [
      ...ANDROID_ID_NODES,
      { ref: '@e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.Button', identifier: 'greet', label: 'Greet again' },
    ];
    expect(testIds(query('testId', 'greet'), { nodes })).toEqual(['greet']);
  });

  it("keeps an app's own id clear of a system window's with the same name", () => {
    const nodes: readonly RawNode[] = [
      ...ANDROID_ID_NODES,
      { ref: '@e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: 'clock', label: '12:00' },
      { ref: '@e8', index: 7, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: 'com.android.systemui:id/clock', label: '9:41' },
    ];
    expect(testIds(query('testId', 'clock'), { nodes })).toEqual(['clock']);
  });

  it('answers every prefixed id with the name when none matches in full, for the runner to refuse as ambiguous', () => {
    const nodes: readonly RawNode[] = [
      ...ANDROID_ID_NODES,
      { ref: '@e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: `${app}:id/clock`, label: '12:00' },
      { ref: '@e8', index: 7, parentIndex: 0, depth: 1, type: 'android.widget.TextView', identifier: 'com.android.systemui:id/clock', label: '9:41' },
    ];
    expect(testIds(query('testId', 'clock'), { nodes })).toEqual([`${app}:id/clock`, 'com.android.systemui:id/clock']);
  });

  it('tests a RegExp against the id without the prefix too', () => {
    const regexp = (source: string): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'testId', value: { kind: 'regexp', source, flags: '' } },
    });
    expect(testIds(regexp('^greet$'))).toEqual([`${app}:id/greet`]);
    expect(testIds(regexp('^dev\\.e2e\\.examples\\.maui:id/gr'))).toEqual([`${app}:id/greet`]);
  });

  it('applies to scopes and has filters', () => {
    const form = query('testId', 'form');
    const scoped: LocatorExpression = { kind: 'query', query: { kind: 'testId', value: exact('greet') }, scope: form };
    expect(testIds(scoped)).toEqual([`${app}:id/greet`]);
    expect(testIds({ kind: 'filter', source: form, has: query('testId', 'name') })).toEqual([`${app}:id/form`]);
  });

  it('leaves iOS identifiers as they are, whatever they spell', () => {
    expect(testIds(query('testId', 'greet'), { platform: 'ios' })).toEqual([]);
  });
});
