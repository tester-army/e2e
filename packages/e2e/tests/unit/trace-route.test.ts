/** Routes: a location reduced to the screen it names, across the URL shapes apps use. */

import { describe, expect, it } from 'vitest';
import { compareRoutes, routeKey, routeOf } from '../../src/cache/route.ts';

const key = (location: string) => routeKey(routeOf(location));
const verdict = (recorded: string, live: string) => compareRoutes(routeOf(recorded), routeOf(live));

describe('routeOf', () => {
  it('abstracts the ids apps mint: uuids, hex and digit runs, random tokens', () => {
    expect(key('/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/runs/:id');
    expect(key('/projects/a77c12665e90/tests')).toBe('/projects/:id/tests');
    expect(key('/orders/42')).toBe('/orders/:id');
    expect(key('/page/1')).toBe('/page/:id');
    expect(key('/blog/2024/09/18/launch-day')).toBe('/blog/:id/:id/:id/launch-day');
    expect(key('/dashboard/e2e-45961c4c/projects/0c1d2e3f4a5b')).toBe('/dashboard/:id/projects/:id');
    expect(key('/keys/omk_7Qx9Lm2Pz4Rt8Wv1')).toBe('/keys/:id');
  });

  it('keeps the words a router owns: versions, locales, dates in words, capitalized and dashed slugs', () => {
    expect(key('/projects/integrations')).toBe('/projects/integrations');
    expect(key('/api/v2/companies-v2/new')).toBe('/api/v2/companies-v2/new');
    expect(key('/en-US/settings/general')).toBe('/en-US/settings/general');
    expect(key('/Products/Summer-Sneaker')).toBe('/Products/Summer-Sneaker');
    expect(key('/users/john_doe')).toBe('/users/john_doe');
    expect(key('/docs/index.html')).toBe('/docs/index.html');
    expect(key('/tags/c++')).toBe('/tags/c++');
    expect(key('/shop/%E9%9E%8B')).toBe('/shop/\u978b');
    expect(key('/projects/new')).not.toBe(key('/projects/a77c12665e90'));
  });

  it('ignores the query, the fragment, a trailing slash, and the origin', () => {
    expect(key('/companies?search=E2E+abc&page=2')).toBe('/companies');
    expect(key('/companies/')).toBe('/companies');
    expect(key('/companies#top')).toBe('/companies');
    expect(key('/settings?')).toBe('/settings');
    expect(key('https://app.example.test/companies?x=1')).toBe('/companies');
    expect(key('/')).toBe('/');
  });

  it('routes by the fragment when the app does', () => {
    expect(key('/#/companies/8374a7a7-a64a-422d-9183-4350756c7f07')).toBe('/companies/:id');
    expect(key('/app/#/settings?tab=2')).toBe('/settings');
    expect(key('https://app.example.test/#/orders/42')).toBe('/orders/:id');
  });

  it('treats a segment with whitespace as a record name, and a literal plus as a literal', () => {
    expect(key('/companies/Acme%20Corp')).toBe('/companies/:id');
    expect(key('/companies/Acme Corp')).toBe('/companies/:id');
    expect(key('/companies/Acme+Corp')).toBe('/companies/Acme+Corp');
  });

  it('keeps an encoded slash inside a segment from becoming a segment', () => {
    expect(routeOf('/a%2Fb/c')).toEqual({ kind: 'url', segments: ['a/b', 'c'] });
    expect(verdict('/a%2Fb/c', '/a/b/c')).toBe('different');
  });

  it('keeps a location that is not a web address as itself: a device screen title, a browser page', () => {
    expect(routeOf('Settings')).toEqual({ kind: 'opaque', location: 'Settings' });
    expect(routeOf('General > About')).toEqual({ kind: 'opaque', location: 'General > About' });
    expect(routeOf('about:blank')).toEqual({ kind: 'opaque', location: 'about:blank' });
    expect(routeOf('chrome-error://chromewebdata/')).toEqual({ kind: 'opaque', location: 'chrome-error://chromewebdata/' });
  });
});

describe('compareRoutes', () => {
  it('is same on equal routes, whatever the ids', () => {
    expect(verdict('/orders/1', '/orders/2')).toBe('same');
    expect(verdict('/companies?search=a', '/companies?search=b#x')).toBe('same');
    expect(verdict('Settings', 'Settings')).toBe('same');
  });

  it('leaves exactly one unexplained segment to the screen, and nothing else', () => {
    expect(verdict('/products/summer-sneaker', '/products/winter-boot')).toBe('undecided');
    expect(verdict('/products/summer-sneaker', '/products/a77c12665e90')).toBe('undecided');
    expect(verdict('/shop/summer/sneaker', '/shop/winter/boot')).toBe('different');
    expect(verdict('/projects', '/projects/a77c12665e90')).toBe('different');
    expect(verdict('/settings/billing', '/settings/members')).toBe('undecided');
    expect(verdict('Settings', 'General')).toBe('different');
    expect(verdict('Settings', '/settings')).toBe('different');
  });
});
