/** The project the server serves: its config, loaded fresh on every use. */

import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';

export interface ProjectOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** Loads the project's config fresh: an agent edits the config while the server runs. */
export async function loadProjectConfig(options: ProjectOptions): Promise<ResolvedConfig> {
  const discovered = discoverConfig(options.cwd, options.configPath);
  if (discovered.configPath === undefined) throw missingConfigError(options.cwd);
  const raw = await loadConfigModule(discovered.configPath);
  return resolveConfig(raw, {
    projectRoot: discovered.projectRoot,
    configPath: discovered.configPath,
    env: options.env,
  });
}
