import { describe, expect, it } from 'vitest';
import { deriveQueries, matchesSignature } from '../../src/agent/locate.ts';
import { OBSERVED_NAME_LIMIT, type SemanticNode } from '../../src/driver/index.ts';
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

  it('relaxes matching only for a name cut at the driver limit', () => {
    const base = 'Hotel Blue Lagoon '.repeat(20);
    const complete = deriveQueries(
      node({ role: 'link', name: base.slice(0, OBSERVED_NAME_LIMIT - 1) }),
      'data-testid',
    );
    expect(complete[0]).toMatchObject({ query: { name: { exact: true } } });

    const truncated = deriveQueries(
      node({ role: 'link', name: base.slice(0, OBSERVED_NAME_LIMIT) }),
      'data-testid',
    );
    expect(truncated[0]).toMatchObject({ query: { name: { exact: false } } });
    expect(describeExpression(truncated[1]!)).toMatch(
      /^getByRole\("link"\)\.filter\(\{ hasText: \//,
    );
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

  it('prefix-matches a name cut at the driver limit against the full re-read name', () => {
    const full = 'Hotel Blue Lagoon '.repeat(20).trim();
    const cut = full.slice(0, OBSERVED_NAME_LIMIT);
    expect(
      matchesSignature(node({ role: 'link', name: cut }), node({ role: 'link', name: full })),
    ).toBe(true);
    expect(
      matchesSignature(node({ role: 'link', name: cut }), node({ role: 'link', name: 'Other' })),
    ).toBe(false);
    // One character below the limit is provably complete: equality required.
    const complete = full.slice(0, OBSERVED_NAME_LIMIT - 1);
    expect(
      matchesSignature(node({ role: 'link', name: complete }), node({ role: 'link', name: full })),
    ).toBe(false);
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
