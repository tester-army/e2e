/** Compile-time assertions for `web({ cookies })`: the `web.setCookies` shape with an optional `url`. */
import type { WebOptions } from '../../src/index.ts';

({ url: 'http://127.0.0.1:3000', cookies: [{ name: 'ack', value: '1' }] }) satisfies WebOptions;
({ cookies: [{ url: 'http://127.0.0.1:3000', name: 'ack', value: '1', sameSite: 'Lax' }] }) satisfies WebOptions;
({ cookies: [{ domain: '127.0.0.1', path: '/', name: 'ack', value: '1' }] }) satisfies WebOptions;

// @ts-expect-error a cookie targets a url or a domain, never both.
({ cookies: [{ url: 'http://127.0.0.1:3000', domain: '127.0.0.1', name: 'ack', value: '1' }] }) satisfies WebOptions;
// @ts-expect-error a path belongs to a domain cookie; a url carries its own.
({ cookies: [{ url: 'http://127.0.0.1:3000', path: '/', name: 'ack', value: '1' }] }) satisfies WebOptions;
// @ts-expect-error a cookie needs a value.
({ cookies: [{ name: 'ack' }] }) satisfies WebOptions;
