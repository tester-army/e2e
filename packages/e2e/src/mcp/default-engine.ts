/**
 * The engine of a session opened without a config file. `open_session`
 * names it as a config would build it, a factory call written as data:
 * `{package: "@e2e-dev/mobile", options: {platform: "ios", device: {package:
 * "@e2e-dev/limrun"}}}` is `mobile({ platform: 'ios', device: limrun() })`.
 * Core still knows no engine: every name is the caller's, and only a package
 * already on disk is loaded.
 */

import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveModuleURL } from 'exsolve';
import { ENGINE_SPI_VERSION } from '../engine/contract.ts';
import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { ConfigurationError, errorMessage, isE2EError } from '../internal/errors.ts';

/** Returns the Node export conditions used for dynamic imports. */
function importConditions(): readonly string[] {
  return process.features.require_module ? ['node', 'import', 'module-sync'] : ['node', 'import'];
}

const engineConditions: readonly string[] = importConditions();

/** npm's package name grammar with an optional subpath, so a path, a URL, or a `..` segment is never resolved. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/;
const REF_KEYS: ReadonlySet<string> = new Set(['package', 'export', 'options']);

/**
 * One factory call: `package`'s default export, or the export `export`
 * names, called with `options`. An option value of this same shape is called
 * first and replaced by what it returns, which is how an engine gets a
 * provider (`device`, `browser`) that JSON cannot carry.
 */
export interface FactoryRef {
  /** The package, with a subpath when the factory lives on one: `@e2e-dev/web`, `@e2e-dev/testmu/web`. */
  readonly package: string;
  /** The export to call; the default export when omitted. */
  readonly export?: string | undefined;
  /** What the factory is called with; a factory that needs none takes `undefined`. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

export interface EngineLookup {
  /** The project directory; its `node_modules` and its parents' are searched first. */
  readonly cwd: string;
  /** The directory engines are installed into for every project (`userEnginesDir()`), searched last. */
  readonly enginesDir: string;
}

/** `~/.e2e/engines`: where an engine installed once serves every project that has no config. */
export function userEnginesDir(): string {
  return path.join(os.homedir(), '.e2e', 'engines');
}

/**
 * Builds the engine `ref` names. Each package is looked up in the project,
 * then beside this copy of e2e (an `npx -p` tree, a global install), then in
 * `lookup.enginesDir`. An engine that brings its own copy of e2e is fine:
 * the handle's brand and contract version are all that cross.
 */
export async function loadEngine(ref: FactoryRef, lookup: EngineLookup): Promise<EngineHandle> {
  const engine = await callFactory(ref, lookup, 'engine');
  if (!isEngineHandle(engine)) {
    throw new ConfigurationError('INVALID_CONFIG', `${describe(ref)} did not return an engine; it must return what defineEngine or connectEngine returns`);
  }
  if (engine.spiVersion !== ENGINE_SPI_VERSION) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${describe(ref)} speaks engine contract ${String(engine.spiVersion)}; this e2e supports ${String(ENGINE_SPI_VERSION)}. Install the version of ${ref.package} that matches this e2e`,
    );
  }
  return engine;
}

/**
 * Calls the factory `ref` names with its options, the factory calls among
 * them made first. `role` is where the call stands: the `engine` itself, or
 * an `option` value read as a call by its shape.
 */
async function callFactory(ref: FactoryRef, lookup: EngineLookup, role: 'engine' | 'option'): Promise<unknown> {
  // A builtin's name resolves to itself, which a file URL would then read as a path in the project.
  if (!PACKAGE.test(ref.package) || isBuiltin(ref.package)) {
    throw new ConfigurationError('INVALID_ARGUMENT', `open_session: engine names an installed package such as "@e2e-dev/web", got ${JSON.stringify(ref.package)}`);
  }
  const name = ref.export ?? 'default';
  if (!EXPORT_NAME.test(name)) {
    throw new ConfigurationError('INVALID_ARGUMENT', `open_session: export names one export of ${ref.package}, got ${JSON.stringify(name)}`);
  }
  const entry = resolveEntry(ref.package, lookup, role);
  let exports: Record<string, unknown>;
  try {
    exports = (await import(entry)) as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigurationError('INVALID_CONFIG', `package ${ref.package} (${entry}) failed to load: ${errorMessage(cause)}`, { cause });
  }
  const factory = exports[name];
  if (typeof factory !== 'function') {
    const callable = Object.keys(exports).filter((key) => key !== 'default' && typeof exports[key] === 'function');
    const others = callable.length === 0 ? 'it exports no function' : `its functions: ${callable.join(', ')}`;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${describe(ref)} (${entry}) is not a function, so there is nothing to call; ${others}. Name one with export, or declare the target in an e2e.config.ts`,
    );
  }
  // The options object is the factory's argument, never a call itself, whatever its keys.
  const options = ref.options === undefined ? undefined : await resolveEntries(ref.options, lookup);
  try {
    return await (factory as (options: unknown) => unknown)(options);
  } catch (cause) {
    // The factory's own refusal (`mobile()` without a platform) already says what to pass.
    if (isE2EError(cause)) throw cause;
    throw new ConfigurationError('INVALID_CONFIG', `${describe(ref)} refused its options: ${errorMessage(cause)}`, { cause });
  }
}

/** `value` with every factory call in it made: objects and arrays are walked, anything else is passed as it is. */
async function resolveOptions(value: unknown, lookup: EngineLookup): Promise<unknown> {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(await resolveOptions(item, lookup));
    return items;
  }
  if (typeof value !== 'object' || value === null) return value;
  return isFactoryRef(value) ? callFactory(value, lookup, 'option') : resolveEntries(value, lookup);
}

/** A copy of `value` with each of its values resolved. */
async function resolveEntries(value: object, lookup: EngineLookup): Promise<Record<string, unknown>> {
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) entries.push([key, await resolveOptions(item, lookup)]);
  // Not assignment: a `__proto__` key from JSON stays an own property instead of becoming the object's prototype.
  return Object.fromEntries(entries);
}

/** An object that is a factory call and nothing else: a `package`, and no key a call does not have. */
function isFactoryRef(value: object): value is FactoryRef {
  const { package: name, export: exported, options } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    Object.keys(value).every((key) => REF_KEYS.has(key)) &&
    (exported === undefined || typeof exported === 'string') &&
    (options === undefined || (typeof options === 'object' && options !== null && !Array.isArray(options)))
  );
}

/** The export a message names: `the default export of <package>`, or `<package> export "<name>"`. */
function describe(ref: FactoryRef): string {
  return ref.export === undefined ? `the default export of ${ref.package}` : `${ref.package} export ${JSON.stringify(ref.export)}`;
}

/**
 * The package's entry URL, from the first place that has the package
 * installed. A package that is there but has no loadable entry is an error
 * of its own, never a reason to look further or to install it again.
 */
function resolveEntry(name: string, lookup: EngineLookup, role: 'engine' | 'option'): string {
  const [first = '', second = ''] = name.split('/');
  const installable = name.startsWith('@') ? `${first}/${second}` : first;
  for (const root of [lookup.cwd, path.dirname(fileURLToPath(import.meta.url)), lookup.enginesDir]) {
    const directory = installedAt(installable, root);
    if (directory === undefined) continue;
    try {
      // The file need not exist: it only says which node_modules directories to walk.
      return resolveModuleURL(name, { from: pathToFileURL(path.join(root, 'package.json')), conditions: [...engineConditions], cache: false });
    } catch (cause) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `package ${name} is installed at ${directory} but its entry cannot be resolved (conditions: ${engineConditions.join(', ')}): ${errorMessage(cause)}. Check the package's exports and entry files`,
        { cause },
      );
    }
  }
  // An option is only read as a call by its shape, so the message says how it was read before it names a command.
  const read = role === 'engine' ? '' : `an option value with only package, export, and options keys is read as a factory call, and `;
  throw new ConfigurationError(
    'ENGINE_NOT_INSTALLED',
    `${read}package ${name} is not installed in ${lookup.cwd}, beside e2e, or in ${lookup.enginesDir}. Install it once for every project with: npm install --prefix ${JSON.stringify(lookup.enginesDir)} ${installable}; then call open_session again. If you cannot run it, for example without network access, ask the user to run it`,
  );
}

/** The directory of `name` in the nearest `node_modules` from `root` upward, as Node.js looks a package up. */
function installedAt(name: string, root: string): string | undefined {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(directory) === directory) return undefined;
  }
}
