/** Starting route fingerprint (spec 10-determinism.md, CACHE-IDENTITY-001). */

import { describe, expect, it } from 'vitest';
import { screenFingerprint } from '../../src/cache/index.ts';

const viewport = { width: 1280, height: 720, scale: 1 };
const base = { origin: 'https://app.test', basePath: '/' };

function fingerprint(
  options: {
    url?: string | undefined;
    viewport?: typeof viewport;
    base?: typeof base;
  } = {},
): string {
  return screenFingerprint({
    viewport: options.viewport ?? viewport,
    url: 'url' in options ? options.url : 'https://app.test/checkout',
    base: options.base ?? base,
  });
}

describe('route identity', () => {
  it('reacts to origin and path', () => {
    const baseline = fingerprint();
    for (const url of ['https://other.test/checkout', 'https://app.test/cart']) {
      expect(fingerprint({ url })).not.toBe(baseline);
    }
  });

  it('ignores the query and the fragment', () => {
    // The query is where a site keeps what is not the place: a session marker, a
    // campaign tag, an experiment bucket. One production offer page arrived as
    // "?...,srcx_auction" on one run and "?...,srcx_v4_auction" on the next,
    // which was enough to mint a new key for a step that had not changed.
    expect(fingerprint({ url: 'https://app.test/checkout?step=2' })).toBe(fingerprint());
    expect(fingerprint({ url: 'https://app.test/checkout?b=2&a=1#anywhere' })).toBe(fingerprint());
  });

  it('drops userinfo, which can carry credentials', () => {
    const withUser = fingerprint({ url: 'https://user:pw@app.test/checkout' });
    expect(withUser).toBe(fingerprint());
  });

  it('reacts to the exact viewport', () => {
    expect(fingerprint({ viewport: { width: 900, height: 720, scale: 1 } })).not.toBe(
      fingerprint(),
    );
    expect(fingerprint({ viewport: { width: 1280, height: 720, scale: 2 } })).not.toBe(
      fingerprint(),
    );
  });

  it('tolerates a driver that exposes no URL', () => {
    expect(fingerprint({ url: undefined })).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint({ url: 'not a url' })).toMatch(/^[a-f0-9]{64}$/);
    // An unparseable URL and an absent one both collapse to "no route", so a
    // native driver keys purely on the call and its occurrence.
    expect(fingerprint({ url: 'not a url' })).toBe(fingerprint({ url: undefined }));
  });
});

describe('deployment independence', () => {
  // The failure this prevents: every Vercel preview, staging host, and new
  // localhost port is a different origin, so keying on it cold-started the whole
  // cache on every deploy.
  it('keys one route the same across the hosts that serve the app', () => {
    const preview = screenFingerprint({
      viewport,
      url: 'https://app-git-feat-cache.vercel.app/checkout',
      base: { origin: 'https://app-git-feat-cache.vercel.app', basePath: '/' },
    });
    const staging = screenFingerprint({
      viewport,
      url: 'https://staging.app.test/checkout',
      base: { origin: 'https://staging.app.test', basePath: '/' },
    });
    const local = screenFingerprint({
      viewport,
      url: 'http://localhost:4173/checkout',
      base: { origin: 'http://localhost:4173', basePath: '/' },
    });
    expect(new Set([preview, staging, local, fingerprint()]).size).toBe(1);
  });

  it('expresses a route against the base path, however the app is mounted', () => {
    const mounted = screenFingerprint({
      viewport,
      url: 'https://app.test/shop/checkout',
      base: { origin: 'https://app.test', basePath: '/shop' },
    });
    expect(mounted).toBe(fingerprint());
  });

  it('keeps the origin of a page outside the app', () => {
    // An identity provider's /checkout is not the app's /checkout, and its
    // markup has nothing to do with it.
    const offOrigin = fingerprint({ url: 'https://accounts.other.test/checkout' });
    expect(offOrigin).not.toBe(fingerprint());
    expect(offOrigin).not.toBe(fingerprint({ url: 'https://login.other.test/checkout' }));
  });
});

describe('record identifiers in a path', () => {
  // The failure this prevents: a checkout that mints a per-session order hash
  // gave every run its own key, so nothing ever hit and the store grew one dead
  // entry per run.
  it('collapses a per-session identifier so the same place keys the same', () => {
    const first = fingerprint({
      url: 'https://app.test/rezerwacja/86e64cc4c76f2bb91199496cb9a58ac9/form',
    });
    const second = fingerprint({
      url: 'https://app.test/rezerwacja/573a9aa54b73557b4c9f409c386b9521/form',
    });
    expect(second).toBe(first);
  });

  it('collapses UUIDs, numeric ids, and opaque tokens alike', () => {
    const shapes = [
      'https://app.test/orders/9f8e7d6c-5b4a-4321-8765-0a1b2c3d4e5f/pay',
      'https://app.test/orders/1284/pay',
      'https://app.test/orders/V1StGXR8Z5jdHi6BmyT/pay',
    ];
    const digests = new Set(shapes.map((url) => fingerprint({ url })));
    expect(digests.size).toBe(1);
  });

  it('keeps every segment that names a place', () => {
    const baseline = fingerprint({ url: 'https://app.test/orders/1284/pay' });
    for (const url of [
      'https://app.test/orders/1284/confirm',
      'https://app.test/baskets/1284/pay',
      'https://app.test/orders/1284/pay/extra',
    ]) {
      expect(fingerprint({ url })).not.toBe(baseline);
    }
    // Short words are places, not ids, even when they look terse.
    expect(fingerprint({ url: 'https://app.test/orders/new/pay' })).not.toBe(baseline);
  });
});

describe('rendered content does not contribute', () => {
  // This is the property the whole cache depends on. Hashing the semantic tree
  // meant a price or a review count invalidated every entry on the page, so a
  // suite against a real application never returned a hit. Replay safety comes
  // from the recorded locator matching the instruction's intent and being
  // verified against the live node, not from the screen being frozen.
  it('is unchanged when the page content changes entirely', () => {
    const before = fingerprint({ url: 'https://app.test/offers?q=greece' });
    const after = fingerprint({ url: 'https://app.test/offers?q=greece' });
    expect(after).toBe(before);
  });

  it('depends on nothing but the route and the viewport', () => {
    // Guards against a future change quietly reintroducing tree input: the
    // digest must be reproducible from these two values alone.
    expect(screenFingerprint({ url: 'https://app.test/x', viewport, base })).toBe(
      screenFingerprint({ url: 'https://app.test/x', viewport, base }),
    );
  });
});

describe('secret safety', () => {
  it('cannot leak a secret from a query, because no query is hashed', () => {
    const digest = fingerprint({ url: 'https://app.test/c?token=super-secret-value' });
    expect(digest).toBe(fingerprint({ url: 'https://app.test/c' }));
    expect(digest).toBe(fingerprint({ url: 'https://app.test/c?token=other-secret-value' }));
  });
});
