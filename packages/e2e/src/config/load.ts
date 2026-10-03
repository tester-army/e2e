/** Config discovery and ESM/TypeScript loading. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, isForeignE2EError } from '../internal/errors.ts';
import type { E2EConfig } from '../types.ts';
import { explainModuleError } from './diagnose.ts';
import { freshModuleURL, registerLoader } from './esm-hooks.ts';
import { forgetTsconfigs } from './tsconfig.ts';

const CONFIG_NAMES = ['e2e.config.ts', 'e2e.config.mts'] as const;

/** Spellings a config author might reach for that the loader does not read. */
const CONFIG_LOOKALIKES = [
  'e2e.config.js',
  'e2e.config.mjs',
  'e2e.config.cjs',
  'e2e.config.cts',
  'e2e.config.json',
  'e2e.config.mts.ts',
  'e2e.ts',
  'e2e.json',
  'e2e-config.ts',
  'e2e.conf.ts',
] as const;

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
 * The failure for a run that found no config file: where the search looked,
 * a lookalike in the working directory when one exists, and otherwise the
 * command that creates a config. Thrown when a config file is discovered,
 * never for a supplied config value.
 */
export function missingConfigError(cwd: string): ConfigurationError {
  const root = path.resolve(cwd);
  const lookalike = CONFIG_LOOKALIKES.find((name) => existsSync(path.join(root, name)));
  const searched = `no ${CONFIG_NAMES.join(' or ')} found in ${root} or its parent directories`;
  const remedy =
    lookalike === undefined
      ? 'run e2e init to create one, or pass --config <path>'
      : `found ${lookalike}, but only ${CONFIG_NAMES.join(' and ')} are loaded: rename it and keep it an ES module`;
  return new ConfigurationError('CONFIG_NOT_FOUND', `${searched}; ${remedy}`);
}

export interface ConfigLoadOptions {
  /**
   * Evaluates every project file the config reaches by path or `#` import
   * afresh too, not only the config file; packages stay shared. For a host
   * that holds several instances of one config at once, each with its own
   * engines, and sees an edited base config on the next load. Opt-in: in a
   * run, a test file that imports a file the config imports gets the same
   * instance, and a fresh graph would split them. Every graph load keeps
   * its own copy of the project's modules for the life of the process, so
   * it is for loads a person or an agent asks for, not a loop.
   */
  readonly graph?: boolean | undefined;
}

/**
 * Imports a TypeScript or JavaScript module through e2e's loader. Every call
 * evaluates the module file afresh: the query carries the caller's key (what
 * the instance is for) plus a process-unique sequence, so a realm never
 * receives another realm's instance of it and a second `run()` in one
 * process sees the file as it is now. The files it imports keep one instance
 * per process; `loadConfigModule` with `graph` refreshes them too.
 */
export async function importModule(absolutePath: string, cacheKey = 'module'): Promise<unknown> {
  return importFresh(absolutePath, cacheKey, false);
}

/** Process-unique sequence that keeps every fresh import's URL distinct. */
let imports = 0;

async function importFresh(absolutePath: string, cacheKey: string, graph: boolean): Promise<unknown> {
  imports += 1;
  registerLoader();
  // A tsconfig.json edited since the last import applies to this one.
  forgetTsconfigs();
  return import(freshModuleURL(absolutePath, `${cacheKey}-${imports}`, graph));
}

/** Loads and returns the raw default export of a config module. */
export async function loadConfigModule(configPath: string, options: ConfigLoadOptions = {}): Promise<E2EConfig> {
  let moduleValue: unknown;
  try {
    moduleValue = await importFresh(configPath, 'module', options.graph === true);
  } catch (cause) {
    // A factory the config calls (web(), mobile()) or
    // `secrets.get()` refusing its options at evaluation is a config error
    // with its own code; only a failed import is a load failure.
    if (cause instanceof ConfigurationError) throw cause;
    if (isForeignE2EError(cause) && cause.category === 'configuration') {
      throw new ConfigurationError(cause.code, cause.message, { cause });
    }
    throw new ConfigurationError(
      'CONFIG_LOAD_FAILED',
      `failed to load config ${configPath}: ${explainModuleError(cause, configPath)}`,
      { cause },
    );
  }
  const defaultExport = (moduleValue as { default?: unknown }).default;
  if (typeof defaultExport !== 'object' || defaultExport === null) {
    const found =
      defaultExport === undefined
        ? 'has no default export'
        : `default-exports ${typeof defaultExport === 'function' ? 'a function' : `a ${typeof defaultExport}`}`;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `config ${configPath} ${found}; write export default { targets: [...] } satisfies E2EConfig`,
    );
  }
  return defaultExport as E2EConfig;
}
