/** Route decision validation that a browser round trip cannot observe. */

import { describe, expect, it } from 'vitest';
import { parseContinue, parseFulfill } from '../../src/route-options.ts';

const resolveUrl = (url: string): string => new URL(url, 'http://127.0.0.1/').href;

describe('route decision headers', () => {
  it('keeps a header named __proto__ as an own header', () => {
    const headers = JSON.parse('{"__proto__":"kept"}') as Record<string, string>;
    const continued = parseContinue({ headers }, 'http://127.0.0.1/echo', resolveUrl).headers!;
    const fulfilled = parseFulfill({ headers }, (file) => file).headers;
    expect(Object.hasOwn(continued, '__proto__') && continued['__proto__']).toBe('kept');
    expect(Object.hasOwn(fulfilled, '__proto__') && fulfilled['__proto__']).toBe('kept');
  });
});
