/** Compile-time assertions for endpoint provisioning and transport recovery. */
import type { PlaywrightConnectOptions } from '../../src/index.ts';

({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async (signal) => {
  signal.throwIfAborted();
  return 'ws://localhost:9222';
} }) satisfies PlaywrightConnectOptions;

// @ts-expect-error recovery cannot omit the fresh-attempt provisioner.
({ reconnectEndpoint: () => 'ws://localhost:9222' }) satisfies PlaywrightConnectOptions;
// @ts-expect-error a recovery resolver must return an endpoint, never a page or a success flag.
({ cdpEndpoint: () => 'ws://localhost:9222', reconnectEndpoint: async () => true }) satisfies PlaywrightConnectOptions;
