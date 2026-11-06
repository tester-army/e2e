/**
 * `resolveExpression`, the reference locator semantics an engine over a
 * semantic tree reproduces. The screen is an iOS Settings page as the mobile
 * engine projects one: an application node, a navigation bar with a button,
 * a cell echoing its static text, a switch, two fields, a hidden button.
 */

import { describe, expect, it } from 'vitest';
import {
  createResolver,
  resolveExpression,
  type LocatorExpression,
  type ResolverPlatform,
  type SemanticNode,
  type SemanticQuery,
  type TextPattern,
} from '../../src/engine/index.ts';

function node(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: '' }, ...fields };
}

const SETTINGS: readonly SemanticNode[] = [
  node('app', {
    role: 'application',
    name: 'Settings',
    text: 'Settings',
    children: [
      node('bar', {
        role: 'navigation',
        name: 'General',
        text: 'General',
        children: [node('back', { role: 'button', name: 'Back', text: 'Back', testId: 'BackButton' })],
      }),
      node('about', {
        role: 'listitem',
        name: 'About',
        text: 'About',
        testId: 'ABOUT',
        children: [node('about-text', { role: 'text', name: 'About', text: 'About' })],
      }),
      node('airplane', { role: 'switch', name: 'Airplane Mode', text: 'Airplane Mode', states: { checked: false } }),
      node('search', { role: 'textbox', name: 'Search', text: 'Search', value: 'wifi' }),
      node('password', {
        role: 'textbox',
        name: 'Password',
        text: 'Password',
        inputPurpose: 'password',
        states: { secure: true },
      }),
      node('hidden', { role: 'button', name: 'Hidden', text: 'Hidden', states: { hidden: true, disabled: true } }),
      node('scroller', { role: 'listitem', name: 'Scroller', text: 'Scroller' }),
    ],
  }),
];

function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

function query(kind: SemanticQuery['kind'], value: string, extra: object = {}): LocatorExpression {
  return { kind: 'query', query: { kind, value: exact(value), ...extra } };
}

function ids(expression: LocatorExpression, nodes: readonly SemanticNode[] = SETTINGS): string[] {
  return resolveExpression(expression, nodes).map((match) => match.ref.id);
}

describe('resolveExpression', () => {
  it('answers role queries with name filters and skips hidden nodes', () => {
    expect(ids(query('role', 'button'))).toEqual(['back']);
    expect(ids(query('role', 'button', { name: exact('Back') }))).toEqual(['back']);
    expect(ids(query('role', 'button', { name: { kind: 'regexp', source: '^ba', flags: 'i' } }))).toEqual(['back']);
    expect(ids(query('role', 'switch', { states: { checked: true } }))).toEqual([]);
    expect(ids(query('role', 'switch', { states: { checked: false } }))).toEqual(['airplane']);
    expect(ids(query('role', 'listitem'))).toEqual(['about', 'scroller']);
  });

  it('requires a heading level exactly, so a tree without levels answers nothing', () => {
    const headings = [node('h1', { role: 'heading', level: 1 }), node('h2', { role: 'heading', level: 2 }), node('h', { role: 'heading' })];
    expect(ids(query('role', 'heading', { level: 2 }), headings)).toEqual(['h2']);
    expect(ids(query('role', 'heading'), headings)).toEqual(['h1', 'h2', 'h']);
    expect(ids(query('role', 'listitem', { level: 1 }))).toEqual([]);
  });

  it('refuses a role query whose value is not a string', () => {
    expect(() => ids({ kind: 'query', query: { kind: 'role', value: { kind: 'regexp', source: 'but', flags: '' } } })).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE' }),
    );
  });

  it('drops hidden nodes from any query kind when it says visible', () => {
    expect(ids(query('text', 'Hidden'))).toEqual(['hidden']);
    expect(ids(query('text', 'Hidden', { visible: true }))).toEqual([]);
    expect(ids(query('role', 'button', { states: { hidden: true }, visible: true }))).toEqual(['back']);
    expect(ids(query('label', 'Search', { visible: true }))).toEqual(['search']);
    expect(ids({ kind: 'index', source: query('text', 'About', { visible: true }), index: 'last' })).toEqual(['about-text']);
  });

  it('answers label, text, display value, placeholder, and test id queries', () => {
    expect(ids(query('label', 'Search'))).toEqual(['search']);
    expect(ids(query('text', 'About'))).toEqual(['about-text']);
    expect(ids({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'abo', exact: false } } })).toEqual([
      'about-text',
    ]);
    expect(ids(query('displayValue', 'wifi'))).toEqual(['search']);
    expect(ids(query('displayValue', 'hunter2'))).toEqual([]);
    expect(ids(query('testId', 'ABOUT'))).toEqual(['about']);
    expect(ids(query('placeholder', 'anything'))).toEqual([]);
    const field = [node('email', { role: 'textbox', attributes: { placeholder: 'you@example.test' } })];
    expect(ids(query('placeholder', 'you@example.test'), field)).toEqual(['email']);
  });

  it('answers text and label queries with the innermost match when an ancestor echoes the text', () => {
    expect(resolveExpression(query('text', 'About'), SETTINGS).map((match) => match.role)).toEqual(['text']);
    expect(ids(query('label', 'About'))).toEqual(['about-text']);
    // The echoing cell still answers role queries, and filters by its subtree text.
    expect(ids(query('role', 'listitem', { name: exact('About') }))).toEqual(['about']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') })).toEqual(['about']);
  });

  it('reads text from the name or the visible text', () => {
    const nodes = [node('named', { role: 'button', name: 'Save' }), node('texted', { text: 'Save' }), node('other', { name: 'Cancel' })];
    expect(ids(query('text', 'Save'), nodes)).toEqual(['named', 'texted']);
    expect(ids(query('label', 'Save'), nodes)).toEqual(['named']);
  });

  it('scopes, filters, and indexes', () => {
    const inBar: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('button') },
      scope: query('role', 'navigation'),
    };
    expect(ids(inBar)).toEqual(['back']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') })).toEqual(['about']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), has: query('role', 'text') })).toEqual(['about']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 'first' })).toEqual(['about']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 'last' })).toEqual(['scroller']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 5 })).toEqual([]);
  });

  it('searches strict descendants of a scope, each once, in document order', () => {
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('application') }, scope: query('role', 'application') })).toEqual([]);
    const nested = [
      node('outer', {
        role: 'group',
        children: [node('inner', { role: 'group', children: [node('leaf', { role: 'button' })] }), node('sibling', { role: 'button' })],
      }),
    ];
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('button') }, scope: query('role', 'group') }, nested)).toEqual([
      'leaf',
      'sibling',
    ]);
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('button') }, scope: query('role', 'list') }, nested)).toEqual([]);
  });

  it('resolves has inside each candidate, never against the whole screen', () => {
    const remove = node('remove', { role: 'button', name: 'Remove' });
    const list = [
      node('alpha', { role: 'listitem', text: 'Alpha', children: [remove] }),
      node('beta', { role: 'listitem', text: 'Beta', children: [node('note', { role: 'text', text: 'Read only' })] }),
    ];
    const items = query('role', 'listitem');
    expect(ids({ kind: 'filter', source: items, has: query('role', 'button', { name: exact('Remove') }) }, list)).toEqual(['alpha']);
    expect(ids({ kind: 'filter', source: items, has: query('text', 'Read only') }, list)).toEqual(['beta']);
    expect(ids({ kind: 'filter', source: items, has: query('role', 'link') }, list)).toEqual([]);
    expect(ids({ kind: 'filter', source: items, hasText: exact('Alpha'), has: query('role', 'button') }, list)).toEqual(['alpha']);
    expect(ids({ kind: 'filter', source: items, hasText: exact('Beta'), has: query('role', 'button') }, list)).toEqual([]);
  });

  it('matches hasText against the name, text, or value of the node or a descendant', () => {
    const rows = [
      node('by-value', { role: 'row', children: [node('field', { role: 'textbox', value: 'draft' })] }),
      node('by-name', { role: 'row', name: 'draft' }),
      node('other', { role: 'row', text: 'final' }),
    ];
    expect(ids({ kind: 'filter', source: query('role', 'row'), hasText: exact('draft') }, rows)).toEqual(['by-value', 'by-name']);
    expect(ids({ kind: 'filter', source: query('role', 'row'), hasText: { kind: 'string', value: 'FIN', exact: false } }, rows)).toEqual([
      'other',
    ]);
  });

  it('hands a selector to the platform hook, and refuses one without it', () => {
    const byTestId = (selector: string, candidates: readonly SemanticNode[]): SemanticNode[] =>
      candidates.filter((candidate) => `id=${candidate.testId ?? ''}` === selector);
    expect(resolveExpression({ kind: 'selector', selector: 'id=ABOUT' }, SETTINGS, { selector: byTestId }).map((m) => m.ref.id)).toEqual([
      'about',
    ]);
    expect(
      resolveExpression(
        { kind: 'filter', source: query('role', 'listitem'), has: { kind: 'selector', selector: 'id=BackButton' } },
        SETTINGS,
        { selector: byTestId },
      ),
    ).toEqual([]);
    expect(() => ids({ kind: 'selector', selector: 'id=ABOUT' })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('"id=ABOUT"') }),
    );
  });

  it('rejects frames, since a semantic tree has no nested documents', () => {
    expect(() => ids({ kind: 'frame', selector: 'iframe', source: query('role', 'button') })).toThrowError(
      expect.objectContaining({ code: 'FRAME_NOT_FOUND', retryable: false }),
    );
  });
});

describe('createResolver', () => {
  /** A platform over numbered nodes, each one's parent at its index in `parents`, where a query's regexp value tests the node's number. */
  function numbered(parents: readonly (number | undefined)[], order?: readonly number[]): ResolverPlatform<number> {
    return {
      nodes: order ?? parents.map((_parent, index) => index),
      parent: (at) => parents[at],
      matches: (at, asked) => asked.value.kind === 'regexp' && new RegExp(asked.value.source).test(String(at)),
      hasText: () => false,
      selector: () => [],
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
    };
  }

  /** A query of `kind` whose value is the regexp `source`. */
  function digits(source: string, kind: SemanticQuery['kind'] = 'role'): LocatorExpression {
    return { kind: 'query', query: { kind, value: { kind: 'regexp', source, flags: '' } } };
  }

  it('orders matches, and counts nth, by the platform order', () => {
    const resolve = createResolver(numbered([undefined, 0, 0], [0, 2, 1]));
    expect(resolve(digits('^[12]$'))).toEqual([2, 1]);
    expect(resolve({ kind: 'index', source: digits('^[12]$'), index: 0 })).toEqual([2]);
  });

  it("resolves has among each match's own descendants, so a position counts inside it", () => {
    // 0 holds 1 (holding 2 and 3) and 4 (holding 5).
    const resolve = createResolver(numbered([undefined, 0, 1, 1, 0, 4]));
    const firstLeaf: LocatorExpression = { kind: 'index', source: digits('^[235]$'), index: 'first' };
    expect(resolve({ kind: 'filter', source: digits('^[14]$'), has: firstLeaf })).toEqual([1, 4]);
    expect(resolve({ kind: 'filter', source: digits('^[14]$'), has: digits('^5$') })).toEqual([4]);
    expect(resolve({ kind: 'filter', source: digits('^[14]$'), hasNot: digits('^5$') })).toEqual([1]);
  });

  it('keeps innermost text matches and scopes to strict descendants of a deep, wide tree in linear time', () => {
    // A chain 400 deep, then 20000 leaves under its last node.
    const depth = 400;
    const parents: (number | undefined)[] = [undefined];
    for (let index = 1; index < depth; index += 1) parents.push(index - 1);
    for (let index = 0; index < 20_000; index += 1) parents.push(depth - 1);
    const resolve = createResolver(numbered(parents));
    const started = performance.now();
    expect(resolve(digits('.', 'text'))).toHaveLength(20_000);
    expect(resolve({ kind: 'query', query: { kind: 'role', value: { kind: 'regexp', source: '.', flags: '' } }, scope: digits('^0$') })).toHaveLength(parents.length - 1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('fails a frame through the platform', () => {
    expect(() => createResolver(numbered([undefined]))({ kind: 'frame', selector: 'iframe', source: digits('0') })).toThrowError(/^FRAME_NOT_FOUND: /);
  });

  it('runs serialized, closing over nothing of its module', () => {
    // oxlint-disable-next-line no-new-func -- the page revives the resolver from its source the same way
    const revived = new Function(`return (${createResolver.toString()})`)() as typeof createResolver;
    expect(revived(numbered([undefined, 0, 1]))(digits('.', 'label'))).toEqual([2]);
  });
});
