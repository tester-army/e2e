/** Config discovery and ESM/TypeScript loading. */

import { existsSync } from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register, type NamespacedUnregister } from 'tsx/esm/api';
import { ConfigurationError } from '../internal/errors.ts';
import type { E2EConfig } from '../types.ts';
import { explainModuleError } from './diagnose.ts';
import { resolveSync } from './esm-hooks.ts';

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
    // The emitted sibling of this module: tsc rewrites import specifiers, not URLs.
    nodeModule.register(new URL('./esm-hooks.js', import.meta.url).href);
  }
  return register({ namespace: 'e2e' });
}

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
  loader ??= registerLoader();
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
