/** Config discovery and ESM/TypeScript loading. */

import { existsSync } from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { register, type NamespacedUnregister } from 'tsx/esm/api';
import { ConfigurationError, isForeignE2EError } from '../internal/errors.ts';
import type { E2EConfig } from '../types.ts';
import { explainModuleError } from './diagnose.ts';
import { freshModuleURL, resolveSync, TSX_NAMESPACE } from './esm-hooks.ts';

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

/**
 * The process-wide TypeScript loader, registered on first use. `tsImport`
 * would register a fresh, never-removed loader hook per call - once per
 * collected file and once per realm, so every import would slow every later
 * one. One namespaced registration serves them all.
 */
let loader: NamespacedUnregister | undefined;
let imports = 0;

/**
 * Node.js floors per major above which tsx registers synchronous hooks,
 * mirroring tsx 4.23.13's `supportsRegisterHooks`: `module.registerHooks`
 * exists and CommonJS can reload from a sync hook. Earlier releases, and
 * Node 23, get asynchronous hooks.
 */
const TSX_SYNC_HOOK_FLOORS: ReadonlyArray<readonly [number, number, number]> = [
  [22, 22, 3],
  [24, 11, 1],
  [25, 1, 0],
  [26, 0, 0],
];

/**
 * Whether tsx registers synchronous hooks on this Node.js. Hook chains only
 * compose within a kind, so e2e's hook has to be registered the same way.
 * A TypeScript `--import` in NODE_OPTIONS makes tsx fall back to async hooks.
 */
export function tsxUsesSyncHooks(
  version = process.versions.node,
  hasRegisterHooks = typeof nodeModule.registerHooks === 'function',
  nodeOptions = process.env.NODE_OPTIONS ?? '',
): boolean {
  if (!hasRegisterHooks) return false;
  if (/(?:^|\s)--import(?:=|\s+)\S+\.(?:[cm]?ts|tsx)(?:[?#]\S*)?(?=\s|$)/.test(nodeOptions)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const last = TSX_SYNC_HOOK_FLOORS.length - 1;
  const floor = TSX_SYNC_HOOK_FLOORS.find((entry, index) => index === last || entry[0] === major);
  if (floor === undefined) return false;
  if (major !== floor[0]) return major > floor[0];
  if (minor !== floor[1]) return minor > floor[1];
  return patch >= floor[2];
}

/**
 * Registers e2e's ESM hook, then tsx. The last registered hook runs first, so
 * tsx's resolve calls e2e's and receives `format: 'module'` for project
 * TypeScript; see esm-hooks.ts.
 */
function registerLoader(): NamespacedUnregister {
  if (tsxUsesSyncHooks()) {
    nodeModule.registerHooks({ resolve: resolveSync });
  } else {
    // The sibling module with this module's own extension: .js in dist, .ts when
    // tests run from source (tsc rewrites import specifiers, not URLs).
    nodeModule.register(import.meta.url.replace(/load(\.[jt]s)$/, 'esm-hooks$1'));
  }
  return register({ namespace: TSX_NAMESPACE });
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
 * Imports a TypeScript/ESM module with erasable-syntax support. Every call
 * evaluates the module file afresh: the query carries the caller's key (what
 * the instance is for) plus a process-unique sequence, so a realm never
 * receives another realm's instance of it and a second `run()` in one
 * process sees the file as it is now. The files it imports keep one instance
 * per process; `loadConfigModule` with `graph` refreshes them too.
 */
export async function importModule(absolutePath: string, cacheKey = 'module'): Promise<unknown> {
  return importFresh(absolutePath, cacheKey, false);
}

async function importFresh(absolutePath: string, cacheKey: string, graph: boolean): Promise<unknown> {
  imports += 1;
  loader ??= registerLoader();
  return loader.import(freshModuleURL(absolutePath, `${cacheKey}-${imports}`, graph), import.meta.url);
}

/** Loads and returns the raw default export of a config module. */
export async function loadConfigModule(configPath: string, options: ConfigLoadOptions = {}): Promise<E2EConfig> {
  let moduleValue: unknown;
  try {
    moduleValue = await importFresh(configPath, 'module', options.graph === true);
  } catch (cause) {
    // An engine factory or `secrets.get()` refusing an option at evaluation is
    // a config error with its own code; only a failed import is a load failure.
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
