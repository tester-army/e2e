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
