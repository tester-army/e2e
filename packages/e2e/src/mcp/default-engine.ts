/**
 * The engine of a session opened without a config file. `open_session`
 * names it as a config would build it, a factory call written as data:
 * `{package: "@e2e-dev/mobile", options: {platform: "ios", device: {package:
 * "@e2e-dev/limrun"}}}` is `mobile({ platform: 'ios', device: limrun() })`.
 * Core still knows no engine: every name is the caller's, and only a package
 * already on disk is loaded.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENGINE_SPI_VERSION } from '../engine/contract.ts';
import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { ConfigurationError, errorMessage, isE2EError } from '../internal/errors.ts';

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
  const engine = await callFactory(ref, lookup);
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

/** Calls the factory `ref` names with its options, the factory calls among them made first. */
async function callFactory(ref: FactoryRef, lookup: EngineLookup): Promise<unknown> {
  if (!PACKAGE.test(ref.package)) {
    throw new ConfigurationError('INVALID_ARGUMENT', `open_session: engine names a package such as "@e2e-dev/web", got ${JSON.stringify(ref.package)}`);
  }
  const name = ref.export ?? 'default';
  if (!EXPORT_NAME.test(name)) {
    throw new ConfigurationError('INVALID_ARGUMENT', `open_session: export names one export of ${ref.package}, got ${JSON.stringify(name)}`);
  }
  const entry = resolveEntry(ref.package, lookup);
  let exports: Record<string, unknown>;
  try {
    exports = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
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
  const options = ref.options === undefined ? undefined : await resolveOptions(ref.options, lookup);
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
  if (isFactoryRef(value)) return callFactory(value, lookup);
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

/** The package's entry file, from the first place that has it installed. */
function resolveEntry(name: string, lookup: EngineLookup): string {
  const roots = [lookup.cwd, path.dirname(fileURLToPath(import.meta.url)), lookup.enginesDir];
  for (const root of roots) {
    try {
      // The file need not exist: it only says which node_modules directories to walk.
      return createRequire(path.join(root, 'package.json')).resolve(name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
      throw new ConfigurationError('INVALID_CONFIG', `package ${name} is installed under ${root} but cannot be resolved: ${errorMessage(cause)}`, { cause });
    }
  }
  const [scope, bare] = name.split('/');
  const installable = name.startsWith('@') ? `${scope}/${bare}` : scope;
  throw new ConfigurationError(
    'ENGINE_NOT_INSTALLED',
    `package ${name} is not installed in ${lookup.cwd}, beside e2e, or in ${lookup.enginesDir}. Install it once for every project with: npm install --prefix ${JSON.stringify(lookup.enginesDir)} ${String(installable)}; then call open_session again`,
  );
}
