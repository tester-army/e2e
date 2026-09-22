/** Compile-time assertions for endpoint provisioning, transport recovery, and the browser provider seam. */
import type { BrowserLease, BrowserProvider, WebConnectOptions, WebOptions } from '../../src/index.ts';

({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async (signal) => {
  signal.throwIfAborted();
  return 'ws://localhost:9222';
} }) satisfies WebConnectOptions;

// @ts-expect-error recovery cannot omit the fresh-attempt provisioner.
({ reconnectEndpoint: () => 'ws://localhost:9222' }) satisfies WebConnectOptions;
// @ts-expect-error a recovery resolver must return an endpoint, never a page or a success flag.
({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async () => true }) satisfies WebConnectOptions;

({ name: 'hosted', scope: 'attempt', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined }) satisfies BrowserProvider;
({ id: 's', cdpEndpoint: 'ws://localhost:9222', reconnectEndpoint: undefined }) satisfies BrowserLease;
({ browser: { name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined } }) satisfies WebOptions;

// @ts-expect-error a lease names its endpoint; a browser object or a page is not one.
({ id: 's', cdpEndpoint: 9222 }) satisfies BrowserLease;
// @ts-expect-error a lease scope is `worker` or `attempt`.
({ name: 'hosted', scope: 'run', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }), release: async () => undefined }) satisfies BrowserProvider;
// @ts-expect-error a provider releases what it leased.
({ name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://x' }) }) satisfies BrowserProvider;

// Gates on the way to a protected app, the page size, and the attribute that carries a test id.
({ headers: { 'x-vercel-protection-bypass': 'token' }, basicAuth: { username: 'preview', password: 'secret' }, viewport: { width: 390, height: 844 }, testIdAttribute: 'data-qa' }) satisfies WebOptions;
// @ts-expect-error basic auth is a username and a password; one without the other is no credential.
({ basicAuth: { username: 'preview' } }) satisfies WebOptions;
// @ts-expect-error a header value is a string; nothing else is sent.
({ headers: { 'x-vercel-protection-bypass': 1 } }) satisfies WebOptions;
// @ts-expect-error a viewport is a width and a height.
({ viewport: { width: 1280 } }) satisfies WebOptions;
// @ts-expect-error the test id attribute is one attribute name.
({ testIdAttribute: ['data-qa', 'data-test'] }) satisfies WebOptions;
