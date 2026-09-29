/** A project the server serves: its config, loaded fresh on every use. */

import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';

export interface ProjectOptions {
  readonly cwd: string;
  /** An explicit config file, relative to `cwd`; otherwise the nearest `e2e.config.ts` from `cwd` upward. */
  readonly configPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** A config loaded from a file, which a session always has: the file is what sessions share. */
export type LoadedConfig = ResolvedConfig & { readonly configPath: string };

/**
 * Loads a project's config fresh, down to the files it imports by path: an
 * agent edits the config, a base config it spreads, or opens another project
 * while the server runs, and the next session sees the files as they are
 * now. Every session also gets engine instances of its own, even from a
 * config that spreads a base config.
 */
export async function loadProjectConfig(options: ProjectOptions): Promise<LoadedConfig> {
  const discovered = discoverConfig(options.cwd, options.configPath);
  const { configPath } = discovered;
  if (configPath === undefined) throw missingConfigError(options.cwd);
  const raw = await loadConfigModule(configPath, { graph: true });
  return { ...resolveConfig(raw, { projectRoot: discovered.projectRoot, configPath, env: options.env }), configPath };
}
