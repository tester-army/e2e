/** The attempt secret ledger: live registration and rotation-safe redaction. */

import { describe, expect, it } from 'vitest';
import { SecretLedger, StreamRedactor } from '../../src/internal/redact.ts';
import { redactResult, textResult } from '../../src/mcp/tools.ts';

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

  it('redacts percent-encoding in lower-case hex, as some servers spell it', () => {
    const path = new SecretLedger([['path', 'a/b c?d']]);
    expect(path.redact('q=a%2fb%20c%3fd')).toBe('q=<secret:path>');
    expect(path.redact('q=a%2Fb+c%3Fd')).toBe('q=<secret:path>');
  });

  it('redacts numeric character references: decimal, zero-padded, hex in either case, and &apos;', () => {
    const quoted = new SecretLedger([['quoted', "it's <ok>"]]);
    expect(quoted.redact('it&#39;s &#60;ok&#62;')).toBe('<secret:quoted>');
    expect(quoted.redact('it&#039;s &lt;ok&gt;')).toBe('<secret:quoted>');
    expect(quoted.redact('it&#x27;s &#x3c;ok&#x3E;')).toBe('<secret:quoted>');
    expect(quoted.redact('it&apos;s &lt;ok&gt;')).toBe('<secret:quoted>');
  });

  it('redacts \\uXXXX JSON escapes in either hex case, once and twice quoted', () => {
    const quoted = new SecretLedger([['quoted', "it's <ok>"]]);
    expect(quoted.redact('{"v":"it\\u0027s \\u003cok\\u003E"}')).toBe('{"v":"<secret:quoted>"}');
    const inner = '{"v":"it\\u0027s \\u003cok\\u003e"}';
    expect(quoted.redact(JSON.stringify({ t: inner }))).toBe(JSON.stringify({ t: '{"v":"<secret:quoted>"}' }));
  });

  it('redacts a double quote doubled, as CSV writes it inside a quoted field', () => {
    const quoted = new SecretLedger([['quoted', 'pa"ss,word']]);
    expect(quoted.redact('id,key\n1,"pa""ss,word"\n')).toBe('id,key\n1,"<secret:quoted>"\n');
    expect(new SecretLedger([['lead', '"quoted']]).redact('"""quoted"')).toBe('"<secret:lead>"');
  });

  it('redacts a slash escaped the way PHP writes JSON', () => {
    expect(new SecretLedger([['path', 'a/b/c']]).redact('{"p":"a\\/b\\/c"}')).toBe('{"p":"<secret:path>"}');
  });

  it('spells letters one way only: a value differing in case is not the secret', () => {
    expect(new SecretLedger([['plain', 'Hunter2']]).redact('hunter2 HUNTER2 Hunter2')).toBe('hunter2 HUNTER2 <secret:plain>');
  });

  it('measures the longest spelling a registered value can take', () => {
    expect(new SecretLedger().maxFormLength).toBe(0);
    expect(new SecretLedger([['plain', 'hunter2']]).maxFormLength).toBe(7);
    expect(new SecretLedger([['quoted', 'a"b']]).maxFormLength).toBe(1 + '\\\\u0022'.length + 1);
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

describe('markers', () => {
  it('redacts twice as it redacts once: a marker it wrote is never read again', () => {
    const ledger = new SecretLedger([['apiKey', 'api']]);
    const once = ledger.redact('key api set');
    expect(once).toBe('key <secret:apiKey> set');
    expect(ledger.redact(once)).toBe(once);
  });

  it('leaves a marker whole when another value is a substring of it, or of the word secret', () => {
    const ledger = new SecretLedger([
      ['long', 'longvalue'],
      ['word', 'secret'],
      ['apiKey', 'api'],
      ['k', 'Key'],
    ]);
    expect(ledger.redact('longvalue api Key secret')).toBe('<secret:long> <secret:apiKey> <secret:k> <secret:word>');
  });

  it('cuts out only the markers of names it knows, so a marker-shaped span holding a raw value is still redacted', () => {
    const ledger = new SecretLedger([['apiKey', 'sk-1234']]);
    expect(ledger.redact('<secret:sk-1234> <secret:other>')).toBe('<secret:<secret:apiKey>> <secret:other>');
  });

  it('keeps the MCP call boundary from rewriting what observe already redacted', () => {
    const ledger = new SecretLedger([['apiKey', 'api']]);
    const observed = textResult('#n3 textbox "Token" value="<secret:apiKey>"');
    expect(redactResult(observed, ledger.redact)).toEqual(observed);
  });
});

describe('redactCut', () => {
  const SECRET = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';

  it('rewrites the leading part of a value the cut stopped inside, down to 8 characters', () => {
    const ledger = new SecretLedger([['apiKey', SECRET]]);
    for (const kept of [59, 40, 8]) {
      const cut = `receipt ${SECRET.slice(0, kept)}`;
      expect(ledger.redact(cut)).toBe(cut);
      expect(ledger.redactCut(cut)).toBe('receipt <secret:apiKey>');
    }
  });

  it('leaves a leading part shorter than the minimum as it is, so plain text is not taken for one', () => {
    const ledger = new SecretLedger([['long', 'ovl-secret-AbCdEfGhIjKlMnOpQrStUvWxYz']]);
    for (const text of ['name-co', 'name-control-o', 'text ovl-sec']) expect(ledger.redactCut(text)).toBe(text);
  });

  it('still rewrites whole values, and the fragment after the last one, down to half of a short value', () => {
    const ledger = new SecretLedger([['member', 'hunter2']]);
    expect(ledger.redactCut('hunter2 then hunter2 then hunt')).toBe('<secret:member> then <secret:member> then <secret:member>');
    expect(ledger.redactCut('hunter2 then hun')).toBe('<secret:member> then hun');
    expect(ledger.redactCut('hunter2hunt')).toBe('<secret:member><secret:member>');
  });

  it('leaves a cut plain value, a fragment not at the end, and a text ending in a marker as they are', () => {
    const ledger = new SecretLedger([['member', 'hunter2']]);
    expect(ledger.redactCut('plain-control-plain-control-pla')).toBe('plain-control-plain-control-pla');
    expect(ledger.redactCut('hunt the snark')).toBe('hunt the snark');
    expect(ledger.redactCut('pw hunter2')).toBe('pw <secret:member>');
    expect(ledger.redactCut('pw <secret:member>')).toBe('pw <secret:member>');
  });

  it('rewrites the longest fragment any value leaves at the end', () => {
    const ledger = new SecretLedger([
      ['short', 'ab-xyz'],
      ['long', 'cab-long-value'],
    ]);
    expect(ledger.redactCut('text cab-long')).toBe('text <secret:long>');
    expect(ledger.redactCut('text ab-')).toBe('text <secret:short>');
  });

  it('rewrites the cut part of a value that starts with another value, or that a whole value runs into, as one marker', () => {
    const prefixed = new SecretLedger([
      ['short', 'abcdef12'],
      ['long', 'abcdef12-XYZ-long'],
    ]);
    expect(prefixed.redactCut('pw abcdef12-XY')).toBe('pw <secret:long>');
    expect(prefixed.redactCut('pw abcdef12 abcdef12-XY')).toBe('pw <secret:short> <secret:long>');
    const chained = new SecretLedger([
      ['first', 'abc123xyz'],
      ['second', 'xyz-tail-value'],
    ]);
    expect(chained.redactCut('pw abc123xyz-tai')).toBe('pw <secret:second>');
  });

  it('changes nothing with no value registered', () => {
    expect(new SecretLedger().redactCut('anything at all')).toBe('anything at all');
  });
});

describe('redactFragments', () => {
  const SECRET = 'cut-secret-Kq7ZrT2mWx9pLd4sNv8bHc3jFg6yQa1eUo5iRk0tYw2zXn7uM';

  it('rewrites a run of 8 or more characters of a value anywhere in the text, and leaves a shorter one', () => {
    const ledger = new SecretLedger([['apiKey', SECRET]]);
    expect(ledger.redactFragments(`cut ${SECRET.slice(0, 59)}`)).toBe('cut <secret:apiKey>');
    expect(ledger.redactFragments(`sel ${SECRET.slice(5, 45)} end`)).toBe('sel <secret:apiKey> end');
    expect(ledger.redactFragments(`a ${SECRET.slice(20, 28)} b`)).toBe('a <secret:apiKey> b');
    expect(ledger.redactFragments(`a ${SECRET.slice(20, 27)} b`)).toBe(`a ${SECRET.slice(20, 27)} b`);
    expect(ledger.redactFragments('plain text, 0123456789 and more')).toBe('plain text, 0123456789 and more');
  });

  it('rewrites whole values in every spelling first, then the fragments between them, and never a marker', () => {
    const ledger = new SecretLedger([['member', 'pa"ss-word-2718-xyz']]);
    expect(ledger.redactFragments('{"v":"pa\\"ss-word-2718-xyz"} ss-word-2718')).toBe('{"v":"<secret:member>"} <secret:member>');
    expect(ledger.redactFragments('<secret:member> and <secret:member>')).toBe('<secret:member> and <secret:member>');
  });

  it('names a run two values share after the longer, and a whole shorter value after itself', () => {
    const short = 'ovl-secret-AbCdEfGhIjKlMnOpQrSt';
    const long = `${short}UvWxYz0123456789ABCDEFGHIJKLMN`;
    const ledger = new SecretLedger([
      ['short', short],
      ['long', long],
    ]);
    expect(ledger.redactFragments(`x ${short.slice(0, 20)}`)).toBe('x <secret:long>');
    expect(ledger.redactFragments(`x ${long.slice(0, 59)}`)).toBe('x <secret:short><secret:long>');
  });

  it('changes nothing with no value registered', () => {
    expect(new SecretLedger().redactFragments('anything at all')).toBe('anything at all');
  });
});

describe('StreamRedactor', () => {
  const secret = 'synthetic-stream-secret-2718';
  const ledger = (): SecretLedger => new SecretLedger([['token', secret]]);

  it('redacts a value split across two writes', () => {
    const stream = new StreamRedactor(ledger());
    const first = stream.push('token synthetic-stream-');
    const second = stream.push('secret-2718 leaked\n');
    expect(first).not.toContain('synthetic');
    expect(first + second).toBe('token <secret:token> leaked\n');
  });

  it('passes a finished line through at once and holds an unfinished one for the next write', () => {
    const stream = new StreamRedactor(ledger());
    expect(stream.push('hello\n')).toBe('hello\n');
    expect(stream.push('progress')).toBe('');
    expect(stream.push(' 50%\n')).toBe('progress 50%\n');
  });

  it('holds no more of a long unfinished line than the longest spelling less one character', () => {
    const registered = ledger();
    const stream = new StreamRedactor(registered);
    const held = registered.maxFormLength - 1;
    expect(stream.push('x'.repeat(200))).toBe('x'.repeat(200 - held));
    expect(stream.flush()).toBe('x'.repeat(held));
  });

  it('moves the cut back over an occurrence it would split', () => {
    const stream = new StreamRedactor(ledger());
    expect(stream.push(`prefix ${secret}${'y'.repeat(30)}`)).toBe('prefix ');
    expect(stream.flush()).toBe(`<secret:token>${'y'.repeat(30)}`);
  });

  it('holds nothing when no value is registered', () => {
    const stream = new StreamRedactor(new SecretLedger());
    expect(stream.push('partial')).toBe('partial');
    expect(stream.flush()).toBe('');
  });

  it('redacts a run of overlapping occurrences longer than any buffer as the whole would, holding under two spellings', () => {
    const periodic = new SecretLedger([['s', 'abababab']]);
    const stream = new StreamRedactor(periodic);
    const text = 'ab'.repeat(40_000);
    let out = '';
    for (let at = 0; at < text.length; at += 1_001) out += stream.push(text.slice(at, at + 1_001));
    expect(out).not.toContain('abababab');
    const tail = stream.flush();
    expect(tail.replaceAll('<secret:s>', 'abababab').length).toBeLessThan(2 * periodic.maxFormLength);
    expect(out + tail).toBe(periodic.redact(text));
    expect(out + tail).toBe('<secret:s>'.repeat(10_000));
  });

  it('decodes bytes as UTF-8, so a character split across two writes still completes a value', () => {
    const euro = new SecretLedger([['pay', 'pay€2718secret']]);
    const stream = new StreamRedactor(euro);
    const bytes = Buffer.from('token pay€2718secret leaked\n', 'utf8');
    const mid = Buffer.byteLength('token pay') + 1;
    const first = stream.push(bytes.subarray(0, mid));
    const second = stream.push(bytes.subarray(mid));
    expect(first).not.toContain('�');
    expect(first + second).toBe('token <secret:pay> leaked\n');
  });

  it('releases an unfinished character on flush instead of holding it', () => {
    const stream = new StreamRedactor(ledger());
    expect(stream.push(Buffer.from([0x68, 0x69, 0xe2])) + stream.flush()).toBe('hi�');
  });

  describe('a marker split across writes', () => {
    const short = (): SecretLedger => new SecretLedger([['apiKey', 'api000']]);

    it('holds an unfinished marker until it closes, so no piece of it is redacted on its own', () => {
      const stream = new StreamRedactor(short());
      expect(stream.push('<secret:api')).toBe('');
      expect(stream.push('Key>')).toBe('');
      expect(stream.flush()).toBe('<secret:apiKey>');
    });

    it('releases a lone < whole once ordinary text follows it', () => {
      const stream = new StreamRedactor(short());
      expect(stream.push('see <')).toBe('');
      expect(stream.push('b> and more text')).toBe('see <b> and more');
      expect(stream.flush()).toBe(' text');
    });

    it('releases an unfinished marker as is on flush', () => {
      const stream = new StreamRedactor(short());
      expect(stream.push('note <secret:abc')).toBe('note ');
      expect(stream.flush()).toBe('<secret:abc');
    });

    it('holds no unfinished marker as long as the longest known marker', () => {
      const stream = new StreamRedactor(short());
      const name = 'a'.repeat(20);
      expect(stream.push(`note <secret:${name}`)).toBe(`note <secret:${name.slice(0, 15)}`);
      expect(stream.flush()).toBe(name.slice(15));
    });
  });
});
