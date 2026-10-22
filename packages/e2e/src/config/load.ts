/** Config discovery and ESM/TypeScript loading. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, InfrastructureError, isE2EError } from '../internal/errors.ts';
import { withConfigSecretReferences } from '../secrets.ts';
import type { E2EConfig } from '../types.ts';
import { explainModuleError } from './diagnose.ts';
import { freshModuleURL, registerLoader } from './esm-hooks.ts';
import { CONFIG_NAMES, JS_CONFIG_NAMES, TS_CONFIG_NAMES } from './names.ts';

/** Spellings a config author might reach for that the loader does not read. */
const CONFIG_LOOKALIKES = [
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
    const typescript = TS_CONFIG_NAMES.filter((name) => existsSync(path.join(dir, name)));
    const present = typescript.length > 0 ? typescript : JS_CONFIG_NAMES.filter((name) => existsSync(path.join(dir, name)));
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
  const names = `${CONFIG_NAMES.slice(0, -1).join(', ')}, or ${CONFIG_NAMES.at(-1)}`;
  const searched = `no ${names} found in ${root} or its parent directories`;
  const remedy =
    lookalike === undefined
      ? 'run e2e init to create one, or pass --config <path>'
      : `found ${lookalike}, but only ${names} is loaded: rename it and keep it an ES module`;
  return new ConfigurationError('CONFIG_NOT_FOUND', `${searched}; ${remedy}`);
}

export interface ConfigLoadOptions {
  /**
   * Evaluates every project file the config reaches by path or `#` import
   * afresh too, not only the config file; packages stay shared. For a host
   * that holds several instances of one config at once, each with its own
   * engines, and sees an edited base config on the next load. Opt-in: in a
   * run, a test file that imports a file the config imports gets the same
   * instance, and a fresh graph would split them. Every graph keeps its
   * own copy of the project's modules for the life of the process, so it
   * is for loads a person or an agent asks for. A string names the graph:
   * modules loaded under one name share their copies, which is how a
   * `--watch` run pays one copy of the project per rerun, not one per file.
   */
  readonly graph?: boolean | string | undefined;
}

/**
 * Imports a TypeScript or JavaScript module through e2e's loader. Every call
 * evaluates the module file afresh: the query carries the caller's key (what
 * the instance is for) plus a process-unique sequence, so a realm never
 * receives another realm's instance of it and a second `run()` in one
 * process sees the file as it is now. The files it imports keep one instance
 * per process, unless `graph` names a fresh graph to load them in, shared
 * by every module loaded under that name.
 */
export async function importModule(absolutePath: string, cacheKey = 'module', graph?: string): Promise<unknown> {
  return importFresh(absolutePath, cacheKey, graph ?? false);
}

/** Process-unique sequence that keeps every fresh import's URL distinct. */
let imports = 0;

async function importFresh(absolutePath: string, cacheKey: string, graph: boolean | string): Promise<unknown> {
  imports += 1;
  registerLoader();
  const key = `${cacheKey}-${imports}`;
  return import(freshModuleURL(absolutePath, key, graph === true ? key : graph === false ? undefined : graph));
}

/** Loads and returns the raw default export of a config module. */
export async function loadConfigModule(configPath: string, options: ConfigLoadOptions = {}): Promise<E2EConfig> {
  // Outside the try: an unsupported Node.js is that, not a config that failed to load.
  registerLoader();
  let moduleValue: unknown;
  try {
    moduleValue = await withConfigSecretReferences(() => importFresh(configPath, 'module', options.graph ?? false));
  } catch (cause) {
    // A factory the config calls (web(), mobile()) or
    // `secrets.get()` refusing its options at evaluation is a config error
    // with its own code; only a failed import is a load failure.
    // So is the loader's own failure (oxc's native binding missing): the project's config is not at fault.
    if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) throw cause;
    if (isE2EError(cause) && cause.category === 'configuration') {
      throw new ConfigurationError(cause.code, cause.message, { cause });
    }
    if (isE2EError(cause) && cause.category === 'infrastructure') {
      throw new InfrastructureError(cause.code, cause.message, { cause });
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
      `config ${configPath} ${found}; write export default { targets: [...] }${/\.m?js$/u.test(configPath) ? '' : ' satisfies E2EConfig'}`,
    );
  }
  return defaultExport as E2EConfig;
}
