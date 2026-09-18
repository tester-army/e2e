/** Routes: a location reduced to the screen it names, across the URL shapes apps use. */

import { describe, expect, it } from 'vitest';
import { routeOf, sameRoute, screenSignature, signatureMatches } from '../../src/cache/route.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const key = (location: string, known: string[] = []) => routeOf(location, known).key;

describe('routeOf', () => {
  it('abstracts the ids apps mint: uuids, hex and digit runs, random tokens', () => {
    expect(key('/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/runs/:id');
    expect(key('/projects/a77c12665e90/tests')).toBe('/projects/:id/tests');
    expect(key('/orders/42')).toBe('/orders/:id');
    expect(key('/orders/48213')).toBe('/orders/:id');
    expect(key('/projects/h6oOdrnB-LwS')).toBe('/projects/:id');
    expect(key('/dashboard/e2e-45961c4c/projects/0c1d2e3f4a5b')).toBe('/dashboard/:id/projects/:id');
  });

  it('keeps the words a router owns, version-like ones included', () => {
    expect(key('/projects/integrations')).toBe('/projects/integrations');
    expect(key('/api/v2/companies-v2/new')).toBe('/api/v2/companies-v2/new');
    expect(key('/en-US/settings/general')).toBe('/en-US/settings/general');
    expect(key('/projects/new')).not.toBe(key('/projects/a77c12665e90'));
  });

  it('ignores the query, the fragment, a trailing slash, and the origin', () => {
    expect(key('/companies?search=E2E+abc&page=2')).toBe('/companies');
    expect(key('/companies/')).toBe('/companies');
    expect(key('/companies#top')).toBe('/companies');
    expect(key('https://app.example.test/companies?x=1')).toBe('/companies');
    expect(key('/')).toBe('/');
  });

  it('routes by the fragment when the app does', () => {
    expect(key('/#/companies/8374a7a7-a64a-422d-9183-4350756c7f07')).toBe('/companies/:id');
    expect(key('/app/#/settings?tab=2')).toBe('/settings');
  });

  it('treats a segment with whitespace as a record name, decoded or plus-encoded', () => {
    expect(key('/companies/Acme%20Corp')).toBe('/companies/:id');
    expect(key('/companies/Acme+Corp')).toBe('/companies/:id');
  });

  it('recognizes a value this call marked, raw, encoded, or as its slug', () => {
    expect(key('/products/e2e-abc-sneaker', ['E2E abc Sneaker'])).toBe('/products/:id');
    expect(key('/products/E2E%20abc%20Sneaker', ['E2E abc Sneaker'])).toBe('/products/:id');
    expect(key('/tags/vip', ['vip'])).toBe('/tags/:id');
    expect(key('/tags/vip', ['gold'])).toBe('/tags/vip');
  });

  it('keeps a location that is not a URL, a device screen title, as itself', () => {
    expect(routeOf('Settings')).toEqual({ key: 'Settings', segments: undefined });
    expect(routeOf('General > About')).toEqual({ key: 'General > About', segments: undefined });
  });
});

describe('sameRoute', () => {
  const never = () => false;
  const always = () => true;

  it('is equality on keys, without asking the arbiter', () => {
    let asked = false;
    expect(sameRoute(routeOf('/orders/1'), routeOf('/orders/2'), () => (asked = true))).toBe(true);
    expect(asked).toBe(false);
  });

  it('asks the arbiter about exactly one unexplained segment, and about nothing else', () => {
    expect(sameRoute(routeOf('/products/summer-sneaker'), routeOf('/products/winter-boot'), always)).toBe(true);
    expect(sameRoute(routeOf('/products/summer-sneaker'), routeOf('/products/winter-boot'), never)).toBe(false);
    expect(sameRoute(routeOf('/products/summer-sneaker'), routeOf('/products/a77c12665e90'), always)).toBe(true);
    expect(sameRoute(routeOf('/shop/summer/sneaker'), routeOf('/shop/winter/boot'), always)).toBe(false);
    expect(sameRoute(routeOf('/projects'), routeOf('/projects/a77c12665e90'), always)).toBe(false);
    expect(sameRoute(routeOf('Settings'), routeOf('General'), always)).toBe(false);
  });
});

describe('screenSignature', () => {
  const redact = createRedactor(new Map());
  const node = (id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode => ({ ref: { id, revision: 'r' }, ...fields });
  const screen = (...list: SemanticNode[]) => new Map(list.map((entry) => [entry.ref.id, entry]));

  it('names a screen by its controls, skipping content, volatile text, and marked values', () => {
    const nodes = screen(
      node('h', { role: 'heading', name: 'Edit product' }),
      node('b', { role: 'button', name: 'Save' }),
      node('f', { role: 'textbox', attributes: { placeholder: 'e.g., Summer sneaker' } }),
      node('l', { role: 'link', name: 'Products & services' }),
      node('p', { text: 'A paragraph of description text' }),
      node('d', { role: 'button', name: 'Added Sep 8, 2026' }),
      node('u', { role: 'heading', name: 'E2E abc Sneaker' }),
      node('n', { text: '11' }),
    );
    expect(screenSignature(nodes, { redact }, ['E2E abc Sneaker'])).toEqual([
      'heading:Edit product',
      'button:Save',
      'textbox:e.g., Summer sneaker',
      'link:Products & services',
    ]);
  });

  it('matches when most of the recorded signature is on screen, and never on too little evidence', () => {
    const recorded = ['heading:Edit product', 'button:Save', 'button:Delete product', 'tab:General data', 'tab:Variants'];
    expect(signatureMatches(recorded, [...recorded.slice(0, 3), 'heading:Winter boot'])).toBe(true);
    expect(signatureMatches(recorded, ['button:Save', 'heading:Company'])).toBe(false);
    expect(signatureMatches(['button:Save', 'button:Cancel'], ['button:Save', 'button:Cancel'])).toBe(false);
  });
});
