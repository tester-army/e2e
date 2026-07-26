import { describe, expect, it } from 'vitest';
import { deriveQueries, matchesSignature } from '../../src/agent/locate.ts';
import type { SemanticNode } from '../../src/driver/index.ts';
import { describeExpression } from '../../src/locator/expression.ts';

function node(extra: Partial<SemanticNode>): SemanticNode {
  return { ref: { id: 'n1', revision: 'r1' }, ...extra };
}

function described(target: SemanticNode): string[] {
  return deriveQueries(target, 'data-testid').map(describeExpression);
}

describe('deriveQueries', () => {
  it('prefers a role and accessible name query', () => {
    expect(described(node({ role: 'button', name: 'Buy now' }))[0]).toBe(
      'getByRole("button", name: "Buy now")',
    );
  });

  it('disambiguates a shared test ID with the node text before using it alone', () => {
    const queries = described(
      node({ role: 'listitem', text: 'Item Gamma', attributes: { 'data-testid': 'item' } }),
    );
    expect(queries).toContain('getByTestId("item").filter({ hasText: "Item Gamma" })');
    expect(queries.indexOf('getByTestId("item").filter({ hasText: "Item Gamma" })')).toBeLessThan(
      queries.indexOf('getByTestId("item")'),
    );
  });

  it('offers placeholder, label, and text fallbacks', () => {
    expect(described(node({ role: 'textbox', attributes: { placeholder: 'you@example.test' } }))).toEqual(
      ['getByPlaceholder("you@example.test")'],
    );
    expect(described(node({ name: 'Email' }))).toEqual([
      'getByLabel("Email")',
      'getByText("Email")',
    ]);
    expect(described(node({ text: 'Duplicated' }))).toEqual(['getByText("Duplicated")']);
  });

  it('normalizes whitespace in derived queries', () => {
    expect(described(node({ role: 'button', name: '  Buy \n now  ' }))[0]).toBe(
      'getByRole("button", name: "Buy now")',
    );
  });

  it('never derives a query from a node with no addressable semantics', () => {
    expect(described(node({}))).toEqual([]);
    expect(described(node({ role: 'generic' }))).toEqual([]);
  });

  it('never emits a node reference, coordinate, or selector', () => {
    const queries = described(
      node({ role: 'button', name: 'Buy', rect: { x: 1, y: 2, width: 3, height: 4 } }),
    );
    for (const query of queries) {
      expect(query).not.toContain('n1');
      expect(query).not.toContain('locator(');
    }
  });
});

describe('matchesSignature', () => {
  it('requires the same role', () => {
    expect(
      matchesSignature(node({ role: 'button', name: 'Buy' }), node({ role: 'link', name: 'Buy' })),
    ).toBe(false);
  });

  it('requires the same accessible name when the observed node has one', () => {
    expect(
      matchesSignature(node({ role: 'button', name: 'Buy' }), node({ role: 'button', name: 'Sell' })),
    ).toBe(false);
    expect(
      matchesSignature(
        node({ role: 'button', name: 'Buy  now' }),
        node({ role: 'button', name: 'Buy now' }),
      ),
    ).toBe(true);
  });

  it('falls back to text containment when the observed node is unnamed', () => {
    expect(matchesSignature(node({ text: 'Gamma' }), node({ text: 'Item Gamma extra' }))).toBe(true);
    expect(matchesSignature(node({ text: 'Gamma' }), node({ text: 'Item Beta' }))).toBe(false);
  });

  it('rejects a resolved node whose input purpose differs', () => {
    expect(
      matchesSignature(
        node({ role: 'textbox', inputPurpose: 'password' }),
        node({ role: 'textbox', inputPurpose: 'username' }),
      ),
    ).toBe(false);
  });

  it('ignores the synthetic document role of the observation root', () => {
    expect(matchesSignature(node({ role: 'document', text: 'Home' }), node({ text: 'Home' }))).toBe(
      true,
    );
  });
});
