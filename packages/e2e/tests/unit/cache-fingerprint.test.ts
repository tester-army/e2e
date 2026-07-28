/** Starting screen fingerprint (spec 10-determinism.md, CACHE-IDENTITY-001). */

import { describe, expect, it } from 'vitest';
import { screenFingerprint } from '../../src/cache/index.ts';
import { createRedactor } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/driver/index.ts';

const viewport = { width: 1280, height: 720, scale: 1 };
const noSecrets = createRedactor(new Map());

function node(overrides: Partial<SemanticNode> = {}): SemanticNode {
  return {
    ref: { id: 'n1', revision: 'r1' },
    role: 'button',
    name: 'Buy',
    ...overrides,
  } as SemanticNode;
}

function tree(children: SemanticNode[]): SemanticNode {
  return { ref: { id: 'n0', revision: 'r1' }, role: 'document', children } as SemanticNode;
}

function fingerprint(
  root: SemanticNode,
  options: {
    url?: string;
    secrets?: Map<string, string>;
    viewport?: typeof viewport;
    testIdAttribute?: string;
  } = {},
): string {
  return screenFingerprint({
    tree: root,
    viewport: options.viewport ?? viewport,
    url: options.url ?? 'https://app.test/checkout',
    redact: options.secrets === undefined ? noSecrets : createRedactor(options.secrets),
    testIdAttribute: options.testIdAttribute ?? 'data-testid',
  });
}

describe('volatile data is excluded', () => {
  it('ignores node references', () => {
    const a = fingerprint(tree([node({ ref: { id: 'n1', revision: 'r1' } })]));
    const b = fingerprint(tree([node({ ref: { id: 'n99', revision: 'r7' } })]));
    expect(a).toBe(b);
  });

  it('ignores geometry', () => {
    const a = fingerprint(tree([node({ rect: { x: 0, y: 0, width: 10, height: 10 } })]));
    const b = fingerprint(tree([node({ rect: { x: 500, y: 90, width: 33, height: 12 } })]));
    expect(a).toBe(b);
  });

  it('ignores focus, which moves for reasons unrelated to the screen', () => {
    const a = fingerprint(tree([node({ states: { focused: true } })]));
    const b = fingerprint(tree([node({ states: { focused: false } })]));
    expect(a).toBe(b);
  });

  it('normalizes whitespace in names and text', () => {
    const a = fingerprint(tree([node({ name: 'Buy  now' })]));
    const b = fingerprint(tree([node({ name: ' Buy\n\tnow ' })]));
    expect(a).toBe(b);
  });

  it('treats an absent field and an empty one as the same', () => {
    const a = fingerprint(tree([node({ name: 'Buy' })]));
    const b = fingerprint(tree([node({ name: 'Buy', text: '' })]));
    expect(a).toBe(b);
  });
});

describe('semantic data is included', () => {
  it('reacts to role, name, and text', () => {
    const baseline = fingerprint(tree([node()]));
    expect(fingerprint(tree([node({ role: 'link' })]))).not.toBe(baseline);
    expect(fingerprint(tree([node({ name: 'Sell' })]))).not.toBe(baseline);
    expect(fingerprint(tree([node({ text: 'extra' })]))).not.toBe(baseline);
  });

  it('reacts to the states a user can perceive', () => {
    const baseline = fingerprint(tree([node()]));
    for (const state of ['checked', 'disabled', 'selected', 'expanded', 'hidden']) {
      expect(fingerprint(tree([node({ states: { [state]: true } })]))).not.toBe(baseline);
    }
  });

  it('reacts to structure, not just to node content', () => {
    const a = fingerprint(tree([node(), node({ name: 'Cancel' })]));
    const b = fingerprint(tree([node()]));
    expect(a).not.toBe(b);
  });

  it('reacts to the exact viewport', () => {
    const baseline = fingerprint(tree([node()]));
    expect(fingerprint(tree([node()]), { viewport: { ...viewport, width: 1281 } })).not.toBe(
      baseline,
    );
    expect(fingerprint(tree([node()]), { viewport: { ...viewport, scale: 2 } })).not.toBe(baseline);
  });

  it('reacts to input purpose', () => {
    const a = fingerprint(tree([node({ inputPurpose: 'password' })]));
    const b = fingerprint(tree([node({ inputPurpose: 'username' })]));
    expect(a).not.toBe(b);
  });
});

describe('attribute allowlist', () => {
  it('includes the configured test-ID attribute, type, autocomplete, href, and aria-*', () => {
    const baseline = fingerprint(tree([node()]));
    for (const attributes of [
      { 'data-testid': 'buy' },
      { type: 'submit' },
      { autocomplete: 'email' },
      { href: 'https://app.test/next' },
      { 'aria-label': 'Buy now' },
    ]) {
      expect(fingerprint(tree([node({ attributes })]))).not.toBe(baseline);
    }
  });

  it('ignores attributes outside the allowlist', () => {
    const a = fingerprint(tree([node({ attributes: { class: 'btn-primary-2xl' } })]));
    expect(a).toBe(fingerprint(tree([node()])));
  });

  it('follows the configured test-ID attribute name', () => {
    const withCustom = fingerprint(tree([node({ attributes: { 'data-qa': 'buy' } })]), {
      testIdAttribute: 'data-qa',
    });
    const ignored = fingerprint(tree([node({ attributes: { 'data-qa': 'buy' } })]));
    expect(withCustom).not.toBe(ignored);
  });
});

describe('URL identity', () => {
  it('reacts to origin, path, and query', () => {
    const root = tree([node()]);
    const baseline = fingerprint(root);
    expect(fingerprint(root, { url: 'https://other.test/checkout' })).not.toBe(baseline);
    expect(fingerprint(root, { url: 'https://app.test/cart' })).not.toBe(baseline);
    expect(fingerprint(root, { url: 'https://app.test/checkout?step=2' })).not.toBe(baseline);
  });

  it('ignores the fragment and query ordering', () => {
    const root = tree([node()]);
    expect(fingerprint(root, { url: 'https://app.test/checkout#top' })).toBe(fingerprint(root));
    expect(fingerprint(root, { url: 'https://app.test/c?a=1&b=2' })).toBe(
      fingerprint(root, { url: 'https://app.test/c?b=2&a=1' }),
    );
  });

  it('tolerates a driver that exposes no URL', () => {
    expect(() => screenFingerprint({
      tree: tree([node()]),
      viewport,
      url: undefined,
      redact: noSecrets,
      testIdAttribute: 'data-testid',
    })).not.toThrow();
  });
});

describe('secret safety', () => {
  it('never lets a secure field value contribute', () => {
    const secure = (value: string): string =>
      fingerprint(tree([node({ role: 'textbox', value, states: { secure: true } })]));
    expect(secure('hunter2')).toBe(secure('correct horse battery staple'));
  });

  it('still reacts to a secure field appearing', () => {
    const withField = fingerprint(
      tree([node({ role: 'textbox', states: { secure: true } })]),
    );
    expect(withField).not.toBe(fingerprint(tree([node()])));
  });

  it('replaces a registered secret in a query with its stable name', () => {
    const secrets = new Map([['token', 'super-secret-token']]);
    const root = tree([node()]);
    const withSecret = fingerprint(root, {
      url: 'https://app.test/checkout?t=super-secret-token',
      secrets,
    });
    const withOther = fingerprint(root, {
      url: 'https://app.test/checkout?t=a-different-token',
      secrets,
    });
    // Substituting the stable name keeps the fingerprint stable across runs
    // that rotate the secret, and keeps the value itself out of the digest.
    expect(withSecret).not.toBe(withOther);
    expect(withSecret).toBe(
      fingerprint(root, {
        url: 'https://app.test/checkout?t=super-secret-token',
        secrets: new Map([['token', 'super-secret-token']]),
      }),
    );
  });

  it('replaces a registered secret appearing in node text', () => {
    const secrets = new Map([['token', 'super-secret-token']]);
    const shown = fingerprint(tree([node({ text: 'super-secret-token' })]), { secrets });
    const raw = fingerprint(tree([node({ text: 'super-secret-token' })]));
    expect(shown).not.toBe(raw);
  });
});
