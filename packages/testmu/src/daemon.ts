import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN = '@agent-device/testmu';

interface Installation {
  directory: string;
  version: string;
}

/** A property of a parsed JSON value, or undefined when the value is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** Resolve a dependency's package directory from its entry, without importing it. */
function installation(name: string): Installation {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const version = field(manifest, 'version');
      if (field(manifest, 'name') === name && typeof version === 'string') return { directory, version };
    } catch { /* The entry may be several directories below its package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the installed ${name} package`);
    directory = parent;
  }
}

/** Throws unless the installed plugin matches the agent-device `@e2e-dev/mobile` runs its daemons with. */
export function assertPluginVersion(expected: string): void {
  const actual = installation(PLUGIN).version;
  if (actual !== expected) throw new Error(`@e2e-dev/testmu uses ${PLUGIN} ${actual}, but @e2e-dev/mobile uses agent-device ${expected}. Install matching versions.`);
}

/**
 * Registers the installed `@agent-device/testmu` in a private agent-device
 * home, the layout `agent-device plugins add` writes, without fetching it
 * from the registry again.
 */
export async function installPlugin(home: string): Promise<void> {
  const plugin = installation(PLUGIN);
  const id = randomUUID();
  const scope = path.join(home, 'plugins', id, 'node_modules', '@agent-device');
  await mkdir(scope, { recursive: true, mode: 0o700 });
  await symlink(plugin.directory, path.join(scope, 'testmu'), 'junction');
  await writeFile(path.join(home, 'config.json'), `${JSON.stringify({ plugins: { [PLUGIN]: { installation: id, version: plugin.version } } })}\n`, { mode: 0o600 });
}
