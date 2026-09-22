import { describe, expect, it } from 'vitest';
import { assertAppId, linkLabel, linkTarget } from '../../src/links.ts';

describe('links', () => {
  it('parses custom schemes and web links, keeping the query the app reads', () => {
    expect(linkTarget('myapp://orders/42?ref=mail').href).toBe('myapp://orders/42?ref=mail');
    expect(linkTarget('HTTPS://Example.com/verify').href).toBe('https://example.com/verify');
  });

  it('lets an app id through to openApp and refuses a link, forbidden schemes first', () => {
    for (const app of ['Settings', 'com.apple.Preferences', 'com.android.settings', 'Notes: Pro', ' Clock ']) {
      expect(() => assertAppId(app)).not.toThrow();
    }
    for (const denied of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'FILE:x', ' data:,x ']) {
      expect(() => assertAppId(denied)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
    for (const link of ['myapp://orders/42', 'https://example.com/verify?token=s3cret', 'myapp:orders']) {
      expect(() => assertAppId(link)).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.not.stringContaining('s3cret') }),
      );
    }
  });

  it('labels a link without its query or fragment, so a magic-link token never enters the report', () => {
    expect(linkLabel('https://app.example.com/magic?token=s3cret#frag')).toBe('https://app.example.com/magic');
    expect(linkLabel('myapp://orders/42')).toBe('myapp://orders/42');
    expect(linkLabel('verify?token=s3cret')).toBe('verify');
  });
});
