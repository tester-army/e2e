import { describe, expect, it } from 'vitest';
import { assertAppId, linkLabel, linkTarget } from '../../src/links.ts';

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

  it('labels a link without its userinfo, query, or fragment', () => {
    expect(linkLabel('myapp://user:secret@orders/42?code=1')).toBe('myapp://orders/42');
    expect(linkLabel('https://user:pass@example.com/verify')).toBe('https://example.com/verify');
    expect(linkLabel('https:/user:pass@example.com/verify')).toBe('https:/example.com/verify');
    expect(linkLabel('https:\\\\user:pass@example.com\\verify')).toBe('https:\\\\example.com\\verify');
    expect(linkLabel('https://token@example.com/verify')).toBe('https://example.com/verify');
    expect(linkLabel('https://a@b:c@example.com/x?token=s3cret#frag')).toBe('https://example.com/x');
    expect(linkLabel('myapp://orders/42#user:secret@x')).toBe('myapp://orders/42');
  });

  it('keeps an @ outside the authority, and leaves app ids and unparseable strings whole', () => {
    expect(linkLabel('https://example.com/users/@me')).toBe('https://example.com/users/@me');
    expect(linkLabel('https://example.com/invite?email=a@b.com')).toBe('https://example.com/invite');
    expect(linkLabel('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(linkLabel('com.example.app')).toBe('com.example.app');
    expect(linkLabel('Notes: Pro')).toBe('Notes: Pro');
    expect(linkLabel('https://user:s3cret@exa mple.com/verify')).toBe('https://exa mple.com/verify');
    expect(linkLabel('://user@x')).toBe('://user@x');
  });
});
