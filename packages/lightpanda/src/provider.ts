/** Lightpanda as a `BrowserProvider` for the web engine: a `lightpanda serve` per lease, or a server already running. */

import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { envValue } from './env.ts';
import { serve, type LightpandaResource, type LightpandaServer } from './server.ts';

const LIGHTPANDA_PATH = 'LIGHTPANDA_PATH';
const LIGHTPANDA_URL = 'LIGHTPANDA_URL';
const DEFAULT_BINARY = 'lightpanda';

/** How long a released server gets to exit on SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5_000;

export interface LightpandaOptions {
  /**
   * The `lightpanda` binary to start: a path, or a name on `PATH`. Default
   * `LIGHTPANDA_PATH` from the run's environment, else `lightpanda`.
   */
  readonly binary?: string | undefined;
  /**
   * A running Lightpanda CDP server to attach to (`ws://host:9222/`, or the
   * `http://` DevTools URL), such as the Docker image in CI, instead of
   * starting one. Default `LIGHTPANDA_URL` from the run's environment; with
   * neither set the provider starts its own. Every slot attaches to the same
   * server, so raise its `--cdp-max-connections` above `workers`.
   */
  readonly endpoint?: string | undefined;
  /**
   * Sub-resources the started server fetches (`iframe`, `image`,
   * `stylesheet`), which Lightpanda skips by default. Not applied to a
   * server reached through `endpoint`.
   */
  readonly loadResources?: readonly LightpandaResource[] | undefined;
  /** Further `lightpanda serve` flags, after `--host`, `--port`, and `--load-resources`. */
  readonly args?: readonly string[] | undefined;
}

/** A lease of a server the provider started; the handle never leaves the side that started it. */
interface ServerLease extends BrowserLease {
  readonly server: LightpandaServer;
}

function isServerLease(lease: BrowserLease): lease is ServerLease {
  return 'server' in lease && typeof lease.server === 'object' && lease.server !== null;
}

/**
 * Lightpanda browsers for `web({ browser: lightpanda() })`: one
 * `lightpanda serve` per worker slot, started on a free port when the
 * engine asks and stopped when it gives the lease back. With `endpoint`,
 * or `LIGHTPANDA_URL` in the run's environment, every lease attaches to
 * that server instead and release leaves it running. Worker scope only:
 * Lightpanda does not expose the default context identity a per-attempt
 * lease reattaches by.
 */
export function lightpanda(options: LightpandaOptions = {}): BrowserProvider {
  const { loadResources = [], args = [] } = options;
  return {
    name: 'lightpanda',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const endpoint = options.endpoint ?? envValue(request.env, LIGHTPANDA_URL);
      if (endpoint !== undefined) {
        request.log(`lightpanda at ${endpoint}`);
        return { id: endpoint, cdpEndpoint: endpoint };
      }
      const binary = options.binary ?? envValue(request.env, LIGHTPANDA_PATH) ?? DEFAULT_BINARY;
      const server = await serve({ binary, loadResources, args, signal: request.signal });
      if (request.signal.aborted) {
        await server.stop(STOP_GRACE_MS);
        throw new Error(`lightpanda ${server.pid} started after the request was cancelled; stopped`);
      }
      request.log(server.version === undefined ? `lightpanda at ${server.cdpEndpoint}` : `lightpanda ${server.version} at ${server.cdpEndpoint}`);
      const lease: ServerLease = { id: String(server.pid), cdpEndpoint: server.cdpEndpoint, server };
      return lease;
    },
    async release(lease: BrowserLease, _context: BrowserReleaseContext): Promise<void> {
      if (isServerLease(lease)) await lease.server.stop(STOP_GRACE_MS);
    },
  };
}
