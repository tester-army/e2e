import { describe, expect, it } from 'vitest';
import { linkLabel, linkTarget } from '../../src/links.ts';

describe('links', () => {
  it('parses custom schemes and web links, keeping the query the app reads', () => {
    expect(linkTarget('myapp://orders/42?ref=mail').href).toBe('myapp://orders/42?ref=mail');
    expect(linkTarget('HTTPS://Example.com/verify').href).toBe('https://example.com/verify');
  });

  it('labels a link without its query or fragment, so a magic-link token never enters the report', () => {
    expect(linkLabel('https://app.example.com/magic?token=s3cret#frag')).toBe('https://app.example.com/magic');
    expect(linkLabel('myapp://orders/42')).toBe('myapp://orders/42');
    expect(linkLabel('verify?token=s3cret')).toBe('verify');
  });
});
