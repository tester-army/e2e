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
