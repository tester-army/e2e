import { describe, expect, it } from 'vitest';
import { assertAppId, linkTarget } from '../../src/links.ts';

describe('links', () => {
  it('parses custom schemes and web links, keeping the query the app reads', () => {
    expect(linkTarget('myapp://orders/42?ref=mail').href).toBe('myapp://orders/42?ref=mail');
    expect(linkTarget('HTTPS://Example.com/verify').href).toBe('https://example.com/verify');
  });

  it('refuses schemes that read local content or wrap a URL that does, in any case or padding', () => {
    for (const denied of [
      'file:///etc/passwd',
      'data:text/html,hi',
      'javascript:alert(1)',
      'view-source:file:///etc/passwd',
      'VIEW-SOURCE:file:///etc/passwd',
      ' view-source:https://example.com/',
      'view-\tsource:file:///etc/passwd',
      'blob:https://example.com/0b7c4c1e',
      'filesystem:https://example.com/temporary/x',
    ]) {
      expect(() => linkTarget(denied), denied).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
      expect(() => assertAppId(denied.replace(/\s/g, '')), denied).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
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

  it('refuses a malformed link without echoing it, wherever a token may sit', () => {
    for (const malformed of [
      'not-a-url?token=s3cret',
      'https://exa mple.com/?token=s3cret',
      'https://user:s3cret@exa mple.com/verify',
      'https://exa mple.com/token=s3cret',
      '://x?token=s3cret',
    ]) {
      expect(() => linkTarget(malformed)).toThrowError(
        expect.objectContaining({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining('openLink needs an absolute URL'),
        }),
      );
      expect(() => linkTarget(malformed)).toThrowError(
        expect.objectContaining({ message: expect.not.stringContaining('s3cret') }),
      );
    }
  });
});
