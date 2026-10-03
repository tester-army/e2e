/**
 * The `headers`, `basicAuth`, `testIdAttribute`, `userAgent`, `locale`, `timezoneId`, `initScripts`, and `screencast` options are checked at
 * config load, so a header the browser could never send or an attribute no
 * element could carry fails the run before a browser launches. What the
 * browser does with valid ones is in tests/integration.
 */

import { describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import { web, type WebOptions } from '../../src/index.ts';
import { httpCredentials } from '../../src/protected-app.ts';

describe('web({ headers })', () => {
  it('accepts an object of header names to string values', () => {
    expect(() =>
      web({ headers: { 'x-vercel-protection-bypass': 'token', 'ngrok-skip-browser-warning': '1' } }),
    ).not.toThrow();
    expect(() => web({ headers: {} })).not.toThrow();
  });

  it('rejects a header name outside the token grammar as INVALID_CONFIG', () => {
    for (const name of ['x bypass', 'x:bypass', '', 'x\nbypass']) {
      expect(() => web({ headers: { [name]: 'v' } })).toThrowError(/invalid header name/);
    }
  });

  it('rejects a value that is not a string or carries a control character, tab excepted', () => {
    expect(() => web({ headers: { 'x-a': 1 as unknown as string } })).toThrowError(/must be a string/);
    expect(() => web({ headers: { 'x-a': 'v\r\nx-b: injected' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': 'token\u0000suffix' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': '\u007f' } })).toThrowError(/control character/);
    expect(() => web({ headers: { 'x-a': 'a\tb' } })).not.toThrow();
  });

  it('rejects headers that are not a plain object, null included', () => {
    for (const headers of [['x-a'], null, 'x-a: v', 3]) {
      expect(() => web({ headers: headers as unknown as Record<string, string> })).toThrowError(
        /must be an object/,
      );
    }
  });
});

describe('web({ basicAuth })', () => {
  it('accepts a username and password', () => {
    expect(() => web({ basicAuth: { username: 'ada', password: '' } })).not.toThrow();
    expect(web({ basicAuth: { username: 'ada', password: 'plain' } }).secrets).toBeUndefined();
  });

  it('declares a secrets.get() password as the engine secret it resolves per attempt', () => {
    const password = secrets.get('stagingPassword');
    const engine = web({ basicAuth: { username: 'ada', password } });
    expect(engine.secrets?.map((secret) => secret.name)).toEqual(['stagingPassword']);
  });

  it('rejects credentials that are not a plain object, null included', () => {
    for (const basicAuth of [null, ['ada', 'x'], 'ada:x']) {
      expect(() =>
        web({ basicAuth: basicAuth as unknown as { username: string; password: string } }),
      ).toThrowError(/must be an object/);
    }
  });

  it('rejects a missing or colon-bearing username and a non-string password', () => {
    expect(() => web({ basicAuth: { username: '', password: 'x' } })).toThrowError(/non-empty username/);
    expect(() => web({ basicAuth: { username: 'ada:x', password: 'x' } })).toThrowError(/":"/);
    expect(() =>
      web({ basicAuth: { username: 'ada', password: undefined as unknown as string } }),
    ).toThrowError(/password string or secrets\.get\(name\)/);
    expect(() =>
      web({ basicAuth: { username: 'ada', password: { name: 'stagingPassword' } as unknown as string } }),
    ).toThrowError(/password string or secrets\.get\(name\)/);
  });
});

describe('web({ testIdAttribute })', () => {
  it('accepts an attribute name', () => {
    for (const attribute of ['data-testid', 'data-qa', 'data-test-id', 'id', 'x:qa', 'data.qa']) {
      expect(() => web({ testIdAttribute: attribute })).not.toThrow();
    }
  });

  it('rejects anything that is not an attribute name as INVALID_CONFIG', () => {
    for (const attribute of ['', ' data-qa', 'data qa', '1-qa', 'data="qa"', 'data-qa]', 3, null]) {
      expect(() => web({ testIdAttribute: attribute as unknown as string })).toThrowError(
        /testIdAttribute.*must be an attribute name/,
      );
    }
  });
});

describe('web({ userAgent })', () => {
  it('accepts a non-empty string', () => {
    expect(() => web({ userAgent: 'Mozilla/5.0 playwright' })).not.toThrow();
  });

  it('rejects an empty or non-string value and a control character', () => {
    expect(() => web({ userAgent: '' })).toThrowError(/non-empty string/);
    expect(() => web({ userAgent: 3 as unknown as string })).toThrowError(/non-empty string/);
    expect(() => web({ userAgent: 'a\r\nx-injected: 1' })).toThrowError(/control character/);
  });

  it('rejects a user-agent header beside it, which would override it on the app site only', () => {
    expect(() => web({ userAgent: 'playwright', headers: { 'User-Agent': 'other' } })).toThrowError(/conflict/);
    expect(() => web({ userAgent: 'playwright', headers: { 'x-preview': 'token' } })).not.toThrow();
  });
});

describe('web({ locale, timezoneId })', () => {
  it('accepts a language tag and an IANA time zone', () => {
    expect(() => web({ locale: 'de-DE', timezoneId: 'Europe/Berlin' })).not.toThrow();
    expect(() => web({ locale: 'zh-Hant-TW', timezoneId: 'UTC' })).not.toThrow();
    expect(() => web({ locale: 'de-DE-u-co-phonebk', timezoneId: 'US/Eastern' })).not.toThrow();
    expect(() => web({ timezoneId: 'GMT' })).not.toThrow();
  });

  it('rejects a value that is no language tag or time zone', () => {
    for (const locale of ['', 'not a locale', 'de_DE', 'und', 'x-private', 3]) {
      expect(() => web({ locale: locale as string })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(/BCP 47/) }));
    }
    for (const timezoneId of ['', 'Mars/Olympus_Mons', 'GMT+25', '+01:00', 'europe/berlin', 'utc', 3]) {
      expect(() => web({ timezoneId: timezoneId as string })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(/IANA time zone/) }));
    }
  });

  it('rejects an accept-language header beside locale, which would override it on the app site only', () => {
    expect(() => web({ locale: 'de-DE', headers: { 'Accept-Language': 'fr' } })).toThrowError(/conflict/);
    expect(() => web({ locale: 'de-DE', headers: { 'x-preview': 'token' } })).not.toThrow();
  });
});

describe('web({ initScripts })', () => {
  it('accepts source, a path, and a function', () => {
    expect(() => web({ initScripts: [] })).not.toThrow();
    expect(() => web({ initScripts: ['window.x = 1', { path: 'shim.js' }, () => undefined] })).not.toThrow();
  });

  it('rejects anything else, naming the entry', () => {
    const refused = (message: RegExp) => expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    const cases: [unknown, RegExp][] = [
      ['window.x = 1', /must be an array of scripts/],
      [[3], /\[0\] must be a string of source, a \{ path \}, or a function, got number/],
      [['ok', null], /\[1\] must be a string of source.*got null/],
      [[{ path: '' }], /\[0\] path must be a non-empty string/],
      [[{ content: 'x' }], /\[0\] takes only path, got content/],
      // oxlint-disable-next-line no-sparse-arrays -- the hole is the case
      [['ok', , 'ok'], /\[1\] must be a string of source.*got undefined/],
    ];
    for (const [initScripts, message] of cases) {
      expect(() => web({ initScripts: initScripts as NonNullable<WebOptions['initScripts']> })).toThrow(refused(message));
    }
  });
});

describe('web({ screencast })', () => {
  it('accepts a whole-pixel size and a 0-100 quality, each optional', () => {
    expect(() => web({ screencast: {} })).not.toThrow();
    expect(() => web({ screencast: { size: { width: 1920, height: 1080 }, quality: 90 } })).not.toThrow();
    expect(() => web({ screencast: { quality: 0 } })).not.toThrow();
  });

  it('rejects a fractional or empty size, a quality outside 0-100, and an unknown key as INVALID_CONFIG', () => {
    for (const screencast of [null, [], 'on', 1, new Date()]) {
      expect(() => web({ screencast } as unknown as Parameters<typeof web>[0])).toThrow(/must be a plain object/);
    }
    const invalid = [
      { size: {} },
      { size: { width: 0, height: 720 } },
      { size: { width: 1280.5, height: 720 } },
      { quality: 101 },
      { quality: 0.5 },
      { size: { width: 1280, height: 720, depth: 2 } },
      { size: new (class Size { width = 1280; height = 720; })() },
      { mode: 'on' },
    ];
    for (const screencast of invalid) {
      expect(() => web({ screencast } as unknown as Parameters<typeof web>[0])).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(() => web({ screencast: { mode: 'on' } } as unknown as Parameters<typeof web>[0])).toThrow(/which attempts record is the config's video/);
  });

  it('refuses the old video key, naming screencast', () => {
    for (const video of [{}, { size: { width: 1280, height: 720 } }, undefined]) {
      expect(() => web({ video } as unknown as Parameters<typeof web>[0])).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('web({ video }) was renamed web({ screencast })') }),
      );
    }
  });
});

describe('web() option keys', () => {
  const refused = (message: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message });

  it('rejects an option it does not know, naming the nearest driving option', () => {
    expect(() => web({ viewprt: { width: 1, height: 1 } } as unknown as Parameters<typeof web>[0])).toThrow(
      refused('web() has unknown key "viewprt"; did you mean "viewport"?'),
    );
    expect(() => web({ launchOptions: {} } as unknown as Parameters<typeof web>[0])).toThrow(
      refused('web() has unknown key "launchOptions"; expected one of browser, viewport, screencast, connect, headers, basicAuth, testIdAttribute, userAgent, locale, timezoneId, initScripts'),
    );
  });

  it('rejects an unknown key inside connect and basicAuth', () => {
    const cdpEndpoint = () => 'ws://127.0.0.1:9222';
    expect(() => web({ connect: { cdpEndpoint, reconectEndpoint: cdpEndpoint } } as unknown as Parameters<typeof web>[0])).toThrow(
      refused('web({ connect }) has unknown key "reconectEndpoint"; did you mean "reconnectEndpoint"?'),
    );
    expect(() => web({ basicAuth: { username: 'u', password: 'p', usernme: 'u' } } as unknown as Parameters<typeof web>[0])).toThrow(
      refused('web({ basicAuth }) has unknown key "usernme"; did you mean "username"?'),
    );
  });

  it('keeps the removed options their own messages', () => {
    expect(() => web({ allowedOrigins: [] } as unknown as Parameters<typeof web>[0])).toThrow(/allowedOrigins }\) is gone/);
  });
});

describe('basic-auth credentials from a secret', () => {
  it('registers the Authorization credential the password becomes, padded and not, for redaction', async () => {
    const asked: { name: string; derived: readonly string[] }[] = [];
    const credentials = await httpCredentials({ username: 'ada', password: secrets.get('stagingPassword') }, async (secret, options) => {
      asked.push({ name: secret.name, derived: options?.derived?.('pa55word!') ?? [] });
      return 'pa55word!';
    });
    expect(credentials).toEqual({ username: 'ada', password: 'pa55word!' });
    const encoded = Buffer.from('ada:pa55word!').toString('base64');
    expect(encoded.endsWith('=')).toBe(true);
    expect(asked).toEqual([{ name: 'stagingPassword', derived: [encoded, encoded.replace(/=+$/, '')] }]);
  });

  it('resolves nothing for a plain string password', async () => {
    const credentials = await httpCredentials({ username: 'ada', password: 'plain-value' }, async () => {
      throw new Error('not a secret');
    });
    expect(credentials).toEqual({ username: 'ada', password: 'plain-value' });
  });
});
