/** A project the server serves: its config, loaded fresh on every use. */

import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';

export interface ProjectOptions {
  readonly cwd: string;
  /** An explicit config file, relative to `cwd`; otherwise the nearest `e2e.config.ts` from `cwd` upward. */
  readonly configPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** Loads a project's config fresh: an agent edits the config, or opens another project, while the server runs. */
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
