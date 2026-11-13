import { randomUUID } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installedPackage } from './package.ts';

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

/**
 * The agent-device plugin whose entry is `entry`, resolved by the integration
 * that depends on it: `agentDevicePlugin(import.meta.resolve('@agent-device/testmu'))`.
 * The package is read on each call, not imported.
 */
export function agentDevicePlugin(entry: string): AgentDevicePlugin {
  return {
    assertVersion(expected) {
      const { name, version } = installedPackage(entry);
      if (version !== expected) throw new Error(`${name} ${version} is installed, but @e2e-dev/mobile runs agent-device ${expected}. Install matching versions.`);
    },
    async prepareHome(home) {
      const { name, directory, version } = installedPackage(entry);
      const id = randomUUID();
      const target = path.join(home, 'plugins', id, 'node_modules', ...name.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await symlink(directory, target, 'junction');
      await writeFile(path.join(home, 'config.json'), `${JSON.stringify({ plugins: { [name]: { installation: id, version } } })}\n`, { mode: 0o600 });
    },
  };
}
