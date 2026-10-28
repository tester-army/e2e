/** A project the server serves: its config, loaded fresh on every use. */

import path from 'node:path';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';

export interface ProjectOptions {
  readonly cwd: string;
  /** An explicit config file, relative to `cwd`; otherwise the nearest config file (`e2e.config.ts`, `.mts`, `.js`, or `.mjs`) from `cwd` upward. */
  readonly configPath?: string | undefined;
}

/** A config loaded from a file, which a session always has: the file is what sessions share. */
export type LoadedConfig = ResolvedConfig & { readonly configPath: string };

/** The absolute path of a project's config, found without evaluating it. */
export function locateProjectConfig(options: ProjectOptions): string {
  const { configPath } = discoverConfig(options.cwd, options.configPath);
  if (configPath === undefined) throw missingConfigError(options.cwd);
  return configPath;
}

/**
 * Loads the config at `configPath` (absolute, from `locateProjectConfig`)
 * fresh, down to the files it imports by path: an agent edits the config, a
 * base config it spreads, or opens another project while the server runs,
 * and the next session sees the files as they are now. Every session also
 * gets engine instances of its own, even from a config that spreads a base
 * config. The project root is the config's directory. `graph` names the
 * session's module graph, which the test files it collects share.
 */
export async function loadProjectConfig(configPath: string, env: NodeJS.ProcessEnv, graph: string): Promise<LoadedConfig> {
  const raw = await loadConfigModule(configPath, { graph });
  return { ...resolveConfig(raw, { projectRoot: path.dirname(configPath), configPath, env }), configPath };
}
