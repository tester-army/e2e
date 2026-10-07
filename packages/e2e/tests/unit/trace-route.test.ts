/** Routes: a location reduced to the screen it names, across the URL shapes apps use. */

import { describe, expect, it } from 'vitest';
import { appLocation, sameRoute } from '../../src/cache/route.ts';

/** Whether every location names the same screen as the first. */
const alike = (first: string, ...others: string[]) => others.every((other) => sameRoute(first, other));

describe('route identity', () => {
  it('abstracts the ids apps mint: uuids, hex and digit runs, random tokens, prefixed record ids', () => {
    expect(alike('/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/runs/8374a7a7-a64a-422d-9183-4350756c7f07')).toBe(true);
    expect(alike('/projects/a77c12665e90/tests', '/projects/0c1d2e3f4a5b/tests')).toBe(true);
    expect(alike('/orders/42', '/orders/7')).toBe(true);
    expect(alike('/blog/2024/09/18/launch-day', '/blog/2025/01/02/launch-day')).toBe(true);
    expect(alike('/dashboard/e2e-45961c4c/projects/0c1d2e3f4a5b', '/dashboard/e2e-12345678/projects/a77c12665e90')).toBe(true);
    expect(alike('/keys/omk_7Qx9Lm2Pz4Rt8Wv1', '/keys/omk_1Ab2Cd3Ef4Gh5Ij')).toBe(true);
    expect(alike('/projects/PROJ-016', '/projects/PROJ-017')).toBe(true);
    expect(alike('/invoices/INV-2041', '/invoices/INV-87')).toBe(true);
  });

  it('keeps the words a router owns: versions, locales, capitalized and dashed slugs', () => {
    for (const [location, other] of [
      ['/projects/integrations', '/projects/settings'],
      ['/api/v2/companies-v2/new', '/api/v3/companies-v2/new'],
      ['/en-US/settings/general', '/de-DE/settings/general'],
      ['/Products/Summer-Sneaker', '/Products/Winter-Boot'],
      ['/users/john_doe', '/users/jane_doe'],
      ['/news/page-2', '/news/page-3'],
      ['/tags/c++', '/tags/c'],
      ['/shop/%E9%9E%8B', '/shop/x'],
      ['/projects/new', '/projects/a77c12665e90'],
      ['/projects', '/projects/a77c12665e90'],
    ] as const) {
      expect(alike(location, location), location).toBe(true);
      expect(alike(location, other), location).toBe(false);
    }
    expect(alike('/shop/%E9%9E%8B', '/shop/\u978b')).toBe(true);
  });

  it('ignores the fragment and a trailing slash, and keeps the origin a location names', () => {
    expect(alike('/companies', '/companies/', '/companies#top')).toBe(true);
    expect(alike('/settings', '/settings?')).toBe(true);
    expect(alike('https://app.example.test/companies?x=1', 'https://app.example.test/companies?x=2')).toBe(true);
    expect(alike('https://app.example.test/companies', '/companies')).toBe(false);
    expect(alike('http://127.0.0.1:4400/shop', 'http://localhost:4400/shop')).toBe(false);
  });

  it('keeps the query as part of the screen, with minted values as ids, in any order', () => {
    expect(alike('/task?mode=unsafe', '/task?mode=safe')).toBe(false);
    expect(alike('/companies?search=E2E+abc&page=2', '/companies?page=3&search=other+term')).toBe(true);
    expect(alike('/companies?tab=notes&sort=name', '/companies?sort=name&tab=notes')).toBe(true);
    expect(alike('/companies?tab=notes', '/companies?tab=files')).toBe(false);
    expect(alike('/companies', '/companies?tab=notes')).toBe(false);
    // Ids, cache busters, signed tokens, timestamps, and dates are the run's, not the screen's.
    expect(alike(
      '/list?id=42&_=1727780000&token=eyJhbGciOiJIUzI1NiJ9.x1.y2&at=2026-10-01T10:00:00Z',
      '/list?id=7&_=1727780999&token=eyJhbGciOiJIUzI1NiJ9.a9.b8&at=2026-10-02T11:30:00Z',
    )).toBe(true);
    expect(alike('/r?8f14e45fceea167a', '/r?c9f0f895fb98ab91')).toBe(true);
    expect(alike('/tickets?open=INV-2041', '/tickets?open=INV-87')).toBe(true);
    expect(alike('/reports?from=2026-10-01&view=week', '/reports?from=2026-10-02&view=week')).toBe(true);
    expect(alike('/reports?from=2026-10-01&view=week', '/reports?from=2026-10-01&view=month')).toBe(false);
  });

  it('routes by the fragment when the app does, its query included', () => {
    expect(alike('/#/companies/8374a7a7-a64a-422d-9183-4350756c7f07', '/companies/1')).toBe(true);
    expect(alike('/app/#/settings?tab=2', '/settings?tab=3')).toBe(true);
    expect(alike('/app/?lang=en#/settings?tab=billing', '/settings?lang=en&tab=billing')).toBe(true);
    expect(alike('https://app.example.test/#/orders/42', 'https://app.example.test/orders/7')).toBe(true);
    expect(alike('/#!/companies/42', '/#/companies/7', '/companies/9')).toBe(true);
    expect(alike('/#!/companies', '/#!/settings')).toBe(false);
  });

  it('treats a segment with whitespace as a record name, and a literal plus as a literal', () => {
    expect(alike('/companies/Acme%20Corp', '/companies/Acme Corp', '/companies/42')).toBe(true);
    expect(alike('/companies/Acme+Corp', '/companies/42')).toBe(false);
  });

  it('keeps an encoded slash inside a segment from becoming a segment', () => {
    expect(alike('/a%2Fb/c', '/a/b/c')).toBe(false);
  });

  it('keeps a location that is not a web address as itself: a device screen title, a browser page', () => {
    for (const location of ['Settings', 'General > About', 'about:blank', 'chrome-error://chromewebdata/']) {
      expect(alike(location, location), location).toBe(true);
    }
    expect(alike('Settings', 'General')).toBe(false);
    expect(alike('Settings', '/Settings')).toBe(false);
  });

  it('reads a record id in a device screen title as an id, by the path segment rules', () => {
    expect(alike('com.example.shop / Order 48213', 'com.example.shop / Order 48214')).toBe(true);
    expect(alike('com.example.shop / Invoice INV-2041', 'com.example.shop / Invoice INV-2042')).toBe(true);
    expect(alike('com.example.shop / Order 48213', 'com.example.shop / Refund 48213')).toBe(false);
    expect(alike('com.example.shop / Page 2', 'com.example.shop / Page two')).toBe(false);
  });
});

describe('appLocation', () => {
  it('keeps a location on the app origin as its path, so another deployment of the app reads alike', () => {
    expect(appLocation('https://pr-12.preview.test/shop?x=1#top', 'https://pr-12.preview.test')).toBe('/shop?x=1#top');
    expect(appLocation('https://other.test/shop', 'https://pr-12.preview.test')).toBe('https://other.test/shop');
    expect(appLocation('https://other.test/shop', undefined)).toBe('https://other.test/shop');
    expect(appLocation('Settings', 'https://pr-12.preview.test')).toBe('Settings');
  });
});
