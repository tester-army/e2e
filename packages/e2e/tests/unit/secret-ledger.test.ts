/** The attempt secret ledger: live registration and rotation-safe redaction. */

import { describe, expect, it } from 'vitest';
import { SecretLedger } from '../../src/internal/redact.ts';

describe('SecretLedger', () => {
  it('redacts values registered after the redact function was handed out', () => {
    const ledger = new SecretLedger([['member', 'hunter2']]);
    const redact = ledger.redact;
    expect(redact('pw is hunter2')).toBe('pw is <secret:member>');
    ledger.register('totp', '123456');
    expect(redact('code 123456 for hunter2')).toBe('code <secret:totp> for <secret:member>');
  });

  it('keeps redacting earlier values after a name rotates', () => {
    const ledger = new SecretLedger();
    ledger.register('totp', '111111');
    ledger.register('totp', '222222');
    expect(ledger.redact('first 111111 then 222222')).toBe(
      'first <secret:totp> then <secret:totp>',
    );
  });

  it('substitutes longer values first, so nested secrets are not half-rewritten', () => {
    const ledger = new SecretLedger([
      ['short', 'abc'],
      ['long', 'abcdef'],
    ]);
    expect(ledger.redact('abcdef abc')).toBe('<secret:long> <secret:short>');
  });
});

describe('encoded forms', () => {
  const ledger = new SecretLedger([['member', 'p@ss "w\\rd" & <x>']]);

  it('redacts the value as a JSON string body, once and twice quoted', () => {
    const once = JSON.stringify({ value: 'p@ss "w\\rd" & <x>' });
    expect(ledger.redact(once)).toBe('{"value":"<secret:member>"}');
    const twice = JSON.stringify({ text: once });
    expect(ledger.redact(twice)).toBe(JSON.stringify({ text: '{"value":"<secret:member>"}' }));
  });

  it('redacts the value URL-encoded as a query component and as a form body', () => {
    expect(ledger.redact(`/login?pw=${encodeURIComponent('p@ss "w\\rd" & <x>')}`)).toBe('/login?pw=<secret:member>');
    expect(ledger.redact(new URLSearchParams({ pw: 'p@ss "w\\rd" & <x>' }).toString())).toBe('pw=<secret:member>');
  });

  it('redacts the value HTML-escaped', () => {
    expect(ledger.redact('<input value="p@ss &quot;w\\rd&quot; &amp; &lt;x&gt;">')).toBe(
      '<input value="<secret:member>">',
    );
  });

  it('adds no forms for a value every encoding leaves alone', () => {
    expect(new SecretLedger([['plain', 'hunter2']]).redact('hunter2 hunter2')).toBe(
      '<secret:plain> <secret:plain>',
    );
  });
});

describe('appearsIn', () => {
  const ledger = new SecretLedger([['member', 'p@ss word']]);

  it('finds a registered value, in any of its forms, inside bytes that are not text', () => {
    const frame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('p%40ss+word'), Buffer.from([0x80])]);
    expect(ledger.appearsIn(frame)).toBe(true);
    expect(ledger.appearsIn(Buffer.from([0xff, 0xd8, 0xff, 0x80, 0x00]))).toBe(false);
    expect(new SecretLedger().appearsIn(Buffer.from('p@ss word'))).toBe(false);
  });

  it('redacts the value as encodeURI spells it in a path', () => {
    expect(ledger.redact('/reset/p@ss%20word/done')).toBe('/reset/<secret:member>/done');
  });
});
