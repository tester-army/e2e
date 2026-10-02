/**
 * Free ports for app URLs and service addresses declared with port 0. The
 * runner picks them once, after the config loads and before anything
 * spawns, and hands the assignments (`config.ports`, keyed by `portKey`) to
 * every worker in its bootstrap, so each process resolves the same URLs and
 * placeholders from the same file.
 */

import net from 'node:net';
import { assignPorts, type ResolvedConfig } from '../config/resolve.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';

/**
 * The config with a free port assigned to every service address that asked
 * for one and has none yet (a target's `app.command` is a service here); the
 * same config when none did. Every port is held until all are chosen, so two
 * requests never receive the same one. A loopback host this machine cannot
 * bind is a bad app URL, reported before anything starts.
 */
export async function allocateAppPorts(config: ResolvedConfig): Promise<ResolvedConfig> {
  const pending = config.portRequests.filter((request) => config.ports[request.key] === undefined);
  if (pending.length === 0) return config;

  const reserved: net.Server[] = [];
  const ports: Record<string, number> = { ...config.ports };
  try {
    for (const { key, owner, host } of pending) {
      let server: net.Server;
      try {
        server = await reserve(host);
      } catch (cause) {
        throw new ConfigurationError(
          'INVALID_APP_URL',
          `${owner} asks for a free port on ${host}, which this machine cannot bind: ${errorMessage(cause)}`,
          { cause },
        );
      }
      reserved.push(server);
      ports[key] = portOf(server);
    }
  } finally {
    await Promise.all(reserved.map(release));
  }
  return assignPorts(config, ports);
}

/** Binds an ephemeral port on `host` and keeps it until released. */
function reserve(host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    // A URL spells an IPv6 host in brackets; the socket API wants it bare.
    server.listen(0, host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host, () => resolve(server));
  });
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('a listening TCP server has an address with a port');
  }
  return address.port;
}

function release(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
