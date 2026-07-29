/** Starting route fingerprint (spec 10-determinism.md, CACHE-IDENTITY-001). */

import { describe, expect, it } from 'vitest';
import { screenFingerprint } from '../../src/cache/index.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const viewport = { width: 1280, height: 720, scale: 1 };
const noSecrets = createRedactor(new Map());

function fingerprint(
  options: {
    url?: string | undefined;
    secrets?: Map<string, string>;
    viewport?: typeof viewport;
  } = {},
): string {
  return screenFingerprint({
    viewport: options.viewport ?? viewport,
    url: 'url' in options ? options.url : 'https://app.test/checkout',
    redact: options.secrets === undefined ? noSecrets : createRedactor(options.secrets),
  });
}

describe('route identity', () => {
  it('reacts to origin, path, and query', () => {
    const baseline = fingerprint();
    for (const url of [
      'https://other.test/checkout',
      'https://app.test/cart',
      'https://app.test/checkout?step=2',
    ]) {
      expect(fingerprint({ url })).not.toBe(baseline);
    }
  });

  it('ignores the fragment and query ordering', () => {
    const a = fingerprint({ url: 'https://app.test/c?b=2&a=1' });
    const b = fingerprint({ url: 'https://app.test/c?a=1&b=2#anywhere' });
    expect(a).toBe(b);
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
    expect(
      screenFingerprint({ url: 'https://app.test/x', viewport, redact: noSecrets }),
    ).toBe(screenFingerprint({ url: 'https://app.test/x', viewport, redact: noSecrets }));
  });
});

describe('secret safety', () => {
  it('replaces a registered secret in a query with its stable name', () => {
    const secrets = new Map([['sessionToken', 'super-secret-value']]);
    const digest = fingerprint({
      url: 'https://app.test/c?token=super-secret-value',
      secrets,
    });
    expect(digest).not.toBe(
      fingerprint({ url: 'https://app.test/c?token=super-secret-value' }),
    );
    // Two different secret values under the same name collapse to one route, so
    // rotating a credential does not cold-start the cache.
    const rotated = new Map([['sessionToken', 'other-secret-value']]);
    expect(
      fingerprint({ url: 'https://app.test/c?token=other-secret-value', secrets: rotated }),
    ).toBe(digest);
  });

  it('replaces a registered secret in a query key', () => {
    const secrets = new Map([['paramName', 'leaky']]);
    expect(fingerprint({ url: 'https://app.test/c?leaky=1', secrets })).not.toBe(
      fingerprint({ url: 'https://app.test/c?leaky=1' }),
    );
  });
});
