/** Config discovery and ESM/TypeScript loading (spec 05-config.md). */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register, type NamespacedUnregister } from 'tsx/esm/api';
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

/**
 * The process-wide TypeScript loader, registered on first use. `tsImport`
 * would register a fresh, never-removed loader hook per call - once per
 * collected file and once per realm, so every import would slow every later
 * one. One namespaced registration serves them all.
 */
let loader: NamespacedUnregister | undefined;
let imports = 0;

/**
 * Imports a TypeScript/ESM module with erasable-syntax support. Every call
 * evaluates the module afresh: the query carries the caller's key (what the
 * instance is for) plus a process-unique sequence, so a realm never receives
 * another realm's module instance and a second `run()` in one process sees
 * the config file as it is now.
 */
export async function importModule(absolutePath: string, cacheKey = 'module'): Promise<unknown> {
  imports += 1;
  const url = `${pathToFileURL(absolutePath).href}?e2e=${cacheKey}-${imports}`;
  loader ??= register({ namespace: 'e2e' });
  return loader.import(url, import.meta.url);
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
