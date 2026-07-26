/** Config discovery and ESM/TypeScript loading (spec 05-config.md). */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ConfigurationError } from '../internal/errors.ts';
import type { E2EConfig } from '../types.ts';

const CONFIG_NAMES = ['e2e.config.ts', 'e2e.config.mts'] as const;

export interface DiscoveredConfig {
  readonly configPath: string | undefined;
  readonly projectRoot: string;
}

/**
 * Discovers the config file. With `--config` the explicit path wins. Otherwise
 * the search starts at cwd and inspects each parent, stopping after the
 * repository root. The selected file's directory is the project root.
 */
export function discoverConfig(cwd: string, explicitPath?: string): DiscoveredConfig {
  if (explicitPath !== undefined) {
    const absolute = path.resolve(cwd, explicitPath);
    if (!existsSync(absolute)) {
      throw new ConfigurationError('CONFIG_NOT_FOUND', `config file not found: ${explicitPath}`);
    }
    return { configPath: absolute, projectRoot: path.dirname(absolute) };
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const present = CONFIG_NAMES.filter((name) => existsSync(path.join(dir, name)));
    if (present.length > 1) {
      throw new ConfigurationError(
        'CONFIG_AMBIGUOUS',
        `found both ${present.join(' and ')} in ${dir}`,
      );
    }
    const name = present[0];
    if (name !== undefined) {
      return { configPath: path.join(dir, name), projectRoot: dir };
    }
    const isRepoRoot = existsSync(path.join(dir, '.git'));
    const parent = path.dirname(dir);
    if (isRepoRoot || parent === dir) break;
    dir = parent;
  }
  return { configPath: undefined, projectRoot: path.resolve(cwd) };
}

/** Imports a TypeScript/ESM module with erasable-syntax support. */
export async function importModule(absolutePath: string, cacheKey?: string): Promise<unknown> {
  const url = pathToFileURL(absolutePath).href + (cacheKey === undefined ? '' : `?e2e=${cacheKey}`);
  return tsImport(url, import.meta.url);
}

/** Loads and returns the raw default export of a config module. */
export async function loadConfigModule(configPath: string): Promise<E2EConfig> {
  let moduleValue: unknown;
  try {
    moduleValue = await importModule(configPath);
  } catch (cause) {
    throw new ConfigurationError(
      'CONFIG_LOAD_FAILED',
      `failed to load config ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const defaultExport = (moduleValue as { default?: unknown }).default;
  if (typeof defaultExport !== 'object' || defaultExport === null) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `config ${configPath} must default-export the object returned by defineConfig()`,
    );
  }
  return defaultExport as E2EConfig;
}
