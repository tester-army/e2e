/** Lightpanda as a `BrowserProvider` for the web engine: one `lightpanda serve` per lease. */

import type { BrowserLease, BrowserProvider, BrowserRequest } from '@e2e-dev/web';
import { findBinary } from './binary.ts';
import { envValue } from './env.ts';
import { serve, type LightpandaResource, type LightpandaServer } from './server.ts';

const LIGHTPANDA_PATH = 'LIGHTPANDA_PATH';

/** How long a server gets to answer on its port before the lease fails. */
const STARTUP_TIMEOUT_MS = 10_000;

/** How long a released server gets to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5_000;

export interface LightpandaOptions {
  /**
   * The `lightpanda` binary to start: a path, or a name on `PATH`. Default
   * `LIGHTPANDA_PATH` from the run's environment, else `lightpanda` on
   * `PATH`, `~/.lightpanda/lightpanda`, or `~/.local/bin/lightpanda`.
   */
  readonly binary?: string | undefined;
  /** Sub-resources the server fetches (`iframe`, `image`, `stylesheet`), which Lightpanda skips by default. */
  readonly loadResources?: readonly LightpandaResource[] | undefined;
  /** Further `lightpanda serve` flags, after `--host`, `--port`, and `--load-resources`. */
  readonly args?: readonly string[] | undefined;
}

/**
 * Lightpanda browsers for `web({ browser: lightpanda() })`: one
 * `lightpanda serve` per worker slot, started on a free port when the
 * engine asks and stopped when it gives the lease back. Worker scope only:
 * Lightpanda does not expose the default context identity a per-attempt
 * lease reattaches by. A server already running is a `web({ connect })`
 * target, not a provider.
 */
export function lightpanda(options: LightpandaOptions = {}): BrowserProvider {
  const { loadResources = [], args = [] } = options;
  // `release` gets back the object `acquire` returned, on the side that acquired it.
  const servers = new WeakMap<BrowserLease, LightpandaServer>();
  return {
    name: 'lightpanda',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const binary = options.binary ?? envValue(request.env, LIGHTPANDA_PATH) ?? findBinary(request.env);
      const server = await serve({ binary, loadResources, args, startupTimeoutMs: STARTUP_TIMEOUT_MS, signal: request.signal });
      request.log(`lightpanda ${server.version} at ${server.cdpEndpoint}`);
      const lease: BrowserLease = { id: server.cdpEndpoint, cdpEndpoint: server.cdpEndpoint };
      servers.set(lease, server);
      return lease;
    },
    async release(lease: BrowserLease): Promise<void> {
      await servers.get(lease)?.stop(STOP_GRACE_MS);
    },
  };
}
