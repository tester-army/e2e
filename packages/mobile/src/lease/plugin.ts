import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** An agent-device provider plugin a lease's daemon loads, as its integration package installed it. */
export interface AgentDevicePlugin {
  /** Throws unless the plugin's version is `expected`, the agent-device this package runs its daemons with. */
  assertVersion(expected: string): void;
  /**
   * Registers the plugin in a daemon's empty agent-device home, the layout
   * `agent-device plugins add` writes, without fetching it from the registry.
   */
  prepareHome(home: string): Promise<void>;
}

interface Installation {
  name: string;
  directory: string;
  version: string;
}

/** A property of a parsed JSON value, or undefined when the value is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** The package an entry belongs to: the nearest `package.json` above it that names a package. */
function installation(entry: string): Installation {
  let directory = path.dirname(fileURLToPath(entry));
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const name = field(manifest, 'name');
      const version = field(manifest, 'version');
      if (typeof name === 'string' && typeof version === 'string') return { name, directory, version };
    } catch { /* The entry may be several directories below its package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the package that ${entry} belongs to`);
    directory = parent;
  }
}

/**
 * The agent-device plugin whose entry is `entry`, resolved by the integration
 * that depends on it: `agentDevicePlugin(import.meta.resolve('@agent-device/testmu'))`.
 * The package is read on each call, not imported.
 */
export function agentDevicePlugin(entry: string): AgentDevicePlugin {
  return {
    assertVersion(expected) {
      const { name, version } = installation(entry);
      if (version !== expected) throw new Error(`${name} ${version} is installed, but @e2e-dev/mobile runs agent-device ${expected}. Install matching versions.`);
    },
    async prepareHome(home) {
      const { name, directory, version } = installation(entry);
      const id = randomUUID();
      const target = path.join(home, 'plugins', id, 'node_modules', ...name.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await symlink(directory, target, 'junction');
      await writeFile(path.join(home, 'config.json'), `${JSON.stringify({ plugins: { [name]: { installation: id, version } } })}\n`, { mode: 0o600 });
    },
  };
}
