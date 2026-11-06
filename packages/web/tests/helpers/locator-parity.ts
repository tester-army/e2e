/**
 * Locator cases the web engine answers as Playwright 1.64.1 does: each a page,
 * an expression, the Playwright locator it mirrors, and the elements
 * Playwright matched there, in its order (each element's `id`). The
 * expectations were recorded by running each `playwright` locator against
 * the same page with playwright-core 1.64.1 on Chromium.
 */

import type { LocatorExpression, SemanticQuery, TextPattern } from 'e2e/engine';

/** One page the cases run on. */
export interface ParityPage {
  readonly name: string;
  readonly html: string;
  readonly cases: readonly ParityCase[];
}

/** One locator and what Playwright matched. */
export interface ParityCase {
  /** The Playwright locator the expression mirrors, over `page`. */
  readonly playwright: string;
  readonly expression: LocatorExpression;
  /** The `id` of each element Playwright matched, in its order. */
  readonly expected: readonly string[];
}

/** A loose string pattern: case-insensitive substring, Playwright's default. */
function loose(value: string): TextPattern {
  return { kind: 'string', value, exact: false };
}

/** An exact string pattern. */
function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

/** A regexp pattern. */
function regexp(source: string, flags = ''): TextPattern {
  return { kind: 'regexp', source, flags };
}

/** A query of `kind` for `value`. */
function query(kind: SemanticQuery['kind'], value: TextPattern, extra: Partial<Omit<SemanticQuery, 'kind' | 'value'>> = {}): LocatorExpression {
  return { kind: 'query', query: { kind, value, ...extra } };
}

/** A role query, with its options. */
function role(name: string, extra: Partial<Omit<SemanticQuery, 'kind' | 'value'>> = {}): LocatorExpression {
  return query('role', exact(name), extra);
}

const GREETING = `<script>
  customElements.define('x-greet', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<b id="hello">Hello</b>'; }
  });
</script>`;

export const PARITY_PAGES: readonly ParityPage[] = [
  {
    name: 'text',
    html: `${GREETING}
<p id="p"><x-greet id="greet"></x-greet> world</p>
<div id="d1">Save <span id="s1">draft</span></div>
<button id="b1">Save</button>
<input id="i1" type="submit" value="Send">
<div id="z">zero&#8203;width</div>
<script id="sc">const hidden = 'Save';</script>`,
    cases: [
      { playwright: "page.getByText('Hello world')", expression: query('text', loose('Hello world')), expected: ['p'] },
      { playwright: "page.getByText('Hello', { exact: true })", expression: query('text', exact('Hello')), expected: ['hello'] },
      { playwright: "page.getByText('save')", expression: query('text', loose('save')), expected: ['d1', 'b1'] },
      { playwright: "page.getByText('Send')", expression: query('text', loose('Send')), expected: ['i1'] },
      { playwright: 'page.getByText(/dra.t/)', expression: query('text', regexp('dra.t')), expected: ['s1'] },
      { playwright: "page.getByText('zerowidth', { exact: true })", expression: query('text', exact('zerowidth')), expected: ['z'] },
    ],
  },
  {
    name: 'roles',
    html: `<style>li.b::before { content: "\\2022 "; }</style>
<ul id="list"><li id="apples" class="b">Apples</li><li id="pears">Pears <span hidden>(sold out)</span></li><li id="plums" aria-label="Plums">x</li></ul>
<div role="status" id="st">Saved</div>
<h1 id="h1">Title</h1><div role="heading" id="h2">Sub</div><h3 id="h3">Three</h3>
<input type="checkbox" id="c1" checked aria-label="Agree"><input type="checkbox" id="c2" aria-label="Some">
<div role="checkbox" id="c3" aria-checked="mixed">Tri</div>
<button id="p1" aria-pressed="true">Bold</button><button id="p2">Italic</button>
<button id="gone" style="display:none">Gone</button><button id="muted" aria-hidden="true">Muted</button>
<button id="menu" aria-expanded="false">Menu</button>
<select id="sel"><option id="o1">One</option><option id="o2" selected>Two</option></select>
<button id="off" disabled>Off</button>
<script>document.getElementById('c2').indeterminate = true;</script>`,
    cases: [
      { playwright: "page.getByRole('listitem')", expression: role('listitem'), expected: ['apples', 'pears', 'plums'] },
      { playwright: "page.getByRole('listitem', { name: 'Pears', exact: true })", expression: role('listitem', { name: exact('Pears') }), expected: [] },
      { playwright: "page.getByRole('listitem', { name: 'apples' })", expression: role('listitem', { name: loose('apples') }), expected: [] },
      { playwright: "page.getByRole('listitem', { name: 'Plums' })", expression: role('listitem', { name: loose('Plums') }), expected: ['plums'] },
      { playwright: "page.getByRole('status', { name: 'Saved' })", expression: role('status', { name: loose('Saved') }), expected: [] },
      { playwright: "page.getByRole('heading')", expression: role('heading'), expected: ['h1', 'h2', 'h3'] },
      { playwright: "page.getByRole('heading', { level: 2 })", expression: role('heading', { level: 2 }), expected: [] },
      { playwright: "page.getByRole('checkbox', { checked: true })", expression: role('checkbox', { states: { checked: true } }), expected: ['c1'] },
      { playwright: "page.getByRole('checkbox', { checked: false })", expression: role('checkbox', { states: { checked: false } }), expected: [] },
      { playwright: "page.getByRole('button', { pressed: true })", expression: role('button', { states: { pressed: true } }), expected: ['p1'] },
      { playwright: "page.getByRole('button', { pressed: false })", expression: role('button', { states: { pressed: false } }), expected: ['p2', 'menu', 'off'] },
      { playwright: "page.getByRole('button', { name: 'Gone' })", expression: role('button', { name: loose('Gone') }), expected: [] },
      { playwright: "page.getByRole('button', { name: 'Muted' })", expression: role('button', { name: loose('Muted') }), expected: [] },
      { playwright: "page.getByRole('button', { expanded: false })", expression: role('button', { states: { expanded: false } }), expected: ['menu'] },
      { playwright: "page.getByRole('option', { selected: true })", expression: role('option', { states: { selected: true } }), expected: ['o2'] },
      { playwright: "page.getByRole('button', { disabled: true })", expression: role('button', { states: { disabled: true } }), expected: ['off'] },
    ],
  },
  {
    name: 'fields',
    html: `<label for="name">Your name</label><input id="name" value="Ada">
<label id="wrap">Email <input id="email" placeholder="you@example.test"></label>
<input id="search" aria-label="Search" value="cats">
<span id="lb">Phone</span><input id="phone" aria-labelledby="lb">
<input id="pw" type="password" value="hunter2" aria-label="Password">
<textarea id="ta">notes here</textarea>
<input id="cb" type="checkbox" value="Ada" aria-label="Ada box">
<div style="display:none"><label>Hidden pad <input id="hp"></label></div>
<button data-testid="go" id="go">Go</button>
<select id="color"><option>Red</option><option selected>Blue</option></select>`,
    cases: [
      { playwright: "page.getByLabel('Your name')", expression: query('label', loose('Your name')), expected: ['name'] },
      { playwright: "page.getByLabel('Email')", expression: query('label', loose('Email')), expected: ['email'] },
      { playwright: "page.getByLabel('Search')", expression: query('label', loose('Search')), expected: ['search'] },
      { playwright: "page.getByLabel('Phone')", expression: query('label', loose('Phone')), expected: ['phone'] },
      { playwright: "page.getByLabel('Hidden pad')", expression: query('label', loose('Hidden pad')), expected: ['hp'] },
      { playwright: "page.getByLabel('Password', { exact: true })", expression: query('label', exact('Password')), expected: ['pw'] },
      { playwright: "page.getByPlaceholder('you@')", expression: query('placeholder', loose('you@')), expected: ['email'] },
      { playwright: "page.getByTestId('go')", expression: query('testId', exact('go')), expected: ['go'] },
    ],
  },
  {
    name: 'structure',
    html: `<ul id="todos">
  <li id="t1">Buy milk <button id="t1b">Delete</button></li>
  <li id="t2">Walk dog <button id="t2b">Delete</button><button id="t2e">Edit</button></li>
  <li id="t3">Read</li>
</ul>
<div id="host"></div><button id="tail">Tail</button>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id="inner">Inner</button>';</script>`,
    cases: [
      { playwright: "page.getByRole('listitem').filter({ hasText: 'milk' })", expression: { kind: 'filter', source: role('listitem'), hasText: loose('milk') }, expected: ['t1'] },
      { playwright: "page.getByRole('listitem').filter({ hasNotText: 'milk' })", expression: { kind: 'filter', source: role('listitem'), hasNotText: loose('milk') }, expected: ['t2', 't3'] },
      { playwright: "page.getByRole('listitem').filter({ hasText: /^Read$/ })", expression: { kind: 'filter', source: role('listitem'), hasText: regexp('^Read$') }, expected: ['t3'] },
      { playwright: "page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit' }) })", expression: { kind: 'filter', source: role('listitem'), has: role('button', { name: loose('Edit') }) }, expected: ['t2'] },
      { playwright: "page.getByRole('listitem').filter({ hasNot: page.getByRole('button') })", expression: { kind: 'filter', source: role('listitem'), hasNot: role('button') }, expected: ['t3'] },
      { playwright: "page.getByRole('listitem').filter({ has: page.getByRole('button').first() })", expression: { kind: 'filter', source: role('listitem'), has: { kind: 'index', source: role('button'), index: 'first' } }, expected: ['t1', 't2'] },
      { playwright: "page.getByRole('list').getByRole('button')", expression: { kind: 'query', query: { kind: 'role', value: exact('button') }, scope: role('list') }, expected: ['t1b', 't2b', 't2e'] },
      { playwright: "page.getByRole('button')", expression: role('button'), expected: ['t1b', 't2b', 't2e', 'tail', 'inner'] },
      { playwright: "page.getByRole('button').nth(3)", expression: { kind: 'index', source: role('button'), index: 3 }, expected: ['tail'] },
      { playwright: "page.getByRole('button').last()", expression: { kind: 'index', source: role('button'), index: 'last' }, expected: ['inner'] },
      { playwright: "page.getByRole('button', { name: 'Inner' }).or(page.getByRole('button', { name: 'Tail' }))", expression: { kind: 'union', left: role('button', { name: loose('Inner') }), right: role('button', { name: loose('Tail') }) }, expected: ['inner', 'tail'] },
      { playwright: "page.getByText('Walk dog')", expression: query('text', loose('Walk dog')), expected: ['t2'] },
      { playwright: "page.getByRole('listitem').getByText('Delete')", expression: { kind: 'query', query: { kind: 'text', value: loose('Delete') }, scope: role('listitem') }, expected: ['t1b', 't2b'] },
    ],
  },
];
