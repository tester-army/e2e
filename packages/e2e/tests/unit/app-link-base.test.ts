/** `app.linkBase`: the link `app.open(path)` opens on a device target. */
import { describe, expect, it } from 'vitest';
import { isRefusedLinkScheme } from 'e2e-core/engine';
import { joinLink, refusesLink } from 'e2e-core/lib/config/app';

describe('joinLink', () => {
  it('joins a path to a base with one slash, and none after a bare scheme', () => {
    expect(joinLink('https://shop.example.com', '/orders/42')).toBe('https://shop.example.com/orders/42');
    expect(joinLink('https://shop.example.com/app/', 'orders/42')).toBe('https://shop.example.com/app/orders/42');
    expect(joinLink('shopapp://', '/orders/42')).toBe('shopapp://orders/42');
    expect(joinLink('shopapp://shop', '/orders/42')).toBe('shopapp://shop/orders/42');
  });

  it('opens an absolute link as given', () => {
    expect(joinLink('shopapp://', 'https://shop.example.com/verify?token=1')).toBe('https://shop.example.com/verify?token=1');
  });
});

describe('refusesLink', () => {
  it('refuses the schemes that read local content or inline a document, and what does not parse', () => {
    for (const link of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'view-source:file:///etc', 'blob:x', 'filesystem:x', 'not a link']) {
      expect(refusesLink(link)).toBe(true);
    }
    expect(refusesLink('shopapp://orders/42')).toBe(false);
    expect(refusesLink('https://shop.example.com/')).toBe(false);
  });

  it('shares its list with engines through e2e-core/engine, by scheme in any case', () => {
    expect(isRefusedLinkScheme('JavaScript:')).toBe(true);
    expect(isRefusedLinkScheme('shopapp:')).toBe(false);
  });
});
