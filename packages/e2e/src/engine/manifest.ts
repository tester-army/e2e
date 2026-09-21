/**
 * The engine manifest: `defineEngine` validates an engine at config load,
 * synchronously and loudly, and computes its capability set. A misspelled
 * member, an undeclared dependency, or a hook where data belongs is
 * `INVALID_CONFIG`, never a silent demotion to a lower tier.
 */

import { engineBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { ENGINE_SPI_VERSION, LOCATOR_ACTION_KINDS, POINTER_ACTION_KINDS } from './contract.ts';
import type { Engine, EngineAppDeclaration, EngineCapability, EngineHandle } from './index.ts';

/** Every key an engine may declare; anything else is rejected at config load. */
const KNOWN_KEYS = [
  'name',
  'version',
  'spiVersion',
  'platform',
  'workers',
  'observe',
  'locate',
  'perform',
  'actions',
  'performAt',
  'pointerActions',
  'keyboard',
  'fixtures',
  'state',
  'artifacts',
  'app',
  'session',
  'prepare',
  'finish',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
] as const satisfies readonly (keyof Engine)[];

/** Hooks of the nested manifests, closed like the top level. */
const NESTED_HOOKS = {
  keyboard: ['type', 'press', 'dismiss'],
  state: ['capture', 'restore'],
  artifacts: ['screenshot', 'startTrace', 'stopTrace', 'startVideo', 'stopVideo'],
  session: ['open', 'back', 'restart', 'reset'],
} as const;

/**
 * Members of the `app` declaration: facts about the app under test, copied
 * through as data. Their values are validated when the config resolves the
 * target, where an error can name it.
 */
const APP_DECLARATION_KEYS = [
  'url',
  'environment',
  'identity',
  'command',
  'readyUrl',
  'services',
] as const satisfies readonly (keyof EngineAppDeclaration)[];

const FUNCTION_MEMBERS = [
  'observe',
  'locate',
  'perform',
  'performAt',
  'prepare',
  'finish',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
] as const;

/** Universal fixture names a contribution may never shadow. */
const RESERVED_FIXTURES = new Set(['agent', 'app', 'screen', 'platform', 'stamp', 'session']);

const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

function invalid(name: string, detail: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `engine "${name}": ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one nested hook manifest (`state`, `artifacts`, `session`): a
 * plain object whose keys are closed and whose members are functions. Returns
 * a copy with every function bound to the manifest, so class-based bodies work.
 */
function hookManifest<K extends keyof typeof NESTED_HOOKS>(
  name: string,
  key: K,
  value: unknown,
  required: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(name, `${key} must be an object`);
  const hooks: readonly string[] = NESTED_HOOKS[key];
  for (const member of Object.keys(value)) {
    if (!hooks.includes(member)) {
      throw invalid(name, `${key} has unknown key "${member}"; expected one of ${hooks.join(', ')}`);
    }
  }
  const bound: Record<string, unknown> = {};
  for (const member of hooks) {
    const fn = value[member];
    if (fn === undefined) {
      if (required.includes(member)) throw invalid(name, `${key}.${member} must be a function`);
      continue;
    }
    if (typeof fn !== 'function') throw invalid(name, `${key}.${member} must be a function`);
    bound[member] = fn.bind(value);
  }
  return bound;
}

/** Validates the `app` declaration: closed data keys, no hooks. */
function appDeclaration(name: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(name, 'app must be an object');
  const keys: readonly string[] = APP_DECLARATION_KEYS;
  const declaration: Record<string, unknown> = {};
  for (const [member, fact] of Object.entries(value)) {
    if (!keys.includes(member)) {
      throw invalid(name, `app has unknown key "${member}"; expected one of ${keys.join(', ')}. Steering hooks belong on session`);
    }
    if (typeof fact === 'function') throw invalid(name, `app.${member} is a declaration, not a hook`);
    if (fact !== undefined) declaration[member] = fact;
  }
  return declaration;
}

/** Validates a declared kind list (`actions`, `pointerActions`): a non-empty list of known kinds, each once. */
function declaredKinds<Kind extends string>(
  name: string,
  member: string,
  value: unknown,
  known: readonly Kind[],
): readonly Kind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(name, `${member} must be a non-empty array of action kinds (${known.join(', ')})`);
  }
  const seen = new Set<string>();
  for (const kind of value) {
    if (typeof kind !== 'string' || !(known as readonly string[]).includes(kind)) {
      throw invalid(name, `${member} names unknown kind ${JSON.stringify(kind)}; expected one of ${known.join(', ')}`);
    }
    if (seen.has(kind)) throw invalid(name, `${member} lists "${kind}" twice`);
    seen.add(kind);
  }
  return Object.freeze([...(value as Kind[])]);
}

/**
 * Validates an engine and computes its capability set.
 *
 * The handle is assembled member by member from the known keys, reading
 * through the prototype chain and binding every function to the spec, so a
 * class instance (own state fields included) is as valid a body as a literal.
 */
export function defineEngine(spec: Engine): EngineHandle {
  if (typeof spec !== 'object' || spec === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'defineEngine requires an engine object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'engine.name must be a non-empty string');
  }
  const name = spec.name;
  if (typeof spec.version !== 'string' || spec.version.trim() === '') {
    throw invalid(name, 'version must be a non-empty string; it is provenance and keys the trace cache');
  }
  if (spec.spiVersion !== ENGINE_SPI_VERSION) {
    throw invalid(
      name,
      `declares spiVersion ${String(spec.spiVersion)}; this runner supports ${ENGINE_SPI_VERSION}`,
    );
  }
  if (spec.platform !== undefined && (typeof spec.platform !== 'string' || spec.platform.trim() === '')) {
    throw invalid(name, 'platform must be a non-empty string when declared');
  }
  // A literal's unknown key is a misspelling or a misplaced tool; a class
  // instance's own fields are its state, so only literals are checked.
  if (Object.getPrototypeOf(spec) === Object.prototype) {
    const known: readonly string[] = KNOWN_KEYS;
    for (const key of Object.keys(spec)) {
      if (!known.includes(key)) {
        throw invalid(name, `unknown key "${key}" - tools belong on the agent, not the engine`);
      }
    }
  }
  for (const member of FUNCTION_MEMBERS) {
    if (spec[member] !== undefined && typeof spec[member] !== 'function') {
      throw invalid(name, `${member} must be a function`);
    }
  }
  if (spec.workers !== undefined && (!Number.isSafeInteger(spec.workers) || spec.workers < 1)) {
    throw invalid(name, 'workers must be a positive safe integer: the most workers the engine serves per target');
  }

  const capabilities = new Set<EngineCapability>();
  if (spec.observe !== undefined) capabilities.add('observation');
  if (spec.perform !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares perform without observe: action targets are observation refs');
    }
    if (spec.actions === undefined) {
      throw invalid(name, 'declares perform without actions: list the action kinds the surface honors');
    }
    capabilities.add('actions');
  } else if (spec.actions !== undefined) {
    throw invalid(name, 'declares actions without perform');
  }
  if (spec.locate !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares locate without observe: located nodes share the observation id space');
    }
    capabilities.add('location');
  }
  if (spec.performAt !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares performAt without observe: a point is read off the observation pixels');
    }
    if (spec.pointerActions === undefined) {
      throw invalid(name, 'declares performAt without pointerActions: list the pointer action kinds the surface honors');
    }
    capabilities.add('pointer');
  } else if (spec.pointerActions !== undefined) {
    throw invalid(name, 'declares pointerActions without performAt');
  }
  if (spec.keyboard !== undefined && !capabilities.has('observation')) {
    throw invalid(name, 'declares keyboard without observe: the focused field is read off the observation');
  }

  const handle: Record<string, unknown> = obj({
    name,
    version: spec.version,
    spiVersion: spec.spiVersion,
    platform: spec.platform,
    workers: spec.workers,
  });
  for (const member of FUNCTION_MEMBERS) {
    const fn = spec[member];
    if (fn !== undefined) handle[member] = fn.bind(spec);
  }
  if (spec.actions !== undefined) handle['actions'] = declaredKinds(name, 'actions', spec.actions, LOCATOR_ACTION_KINDS);
  if (spec.pointerActions !== undefined) {
    handle['pointerActions'] = declaredKinds(name, 'pointerActions', spec.pointerActions, POINTER_ACTION_KINDS);
  }
  if (spec.fixtures !== undefined) {
    if (!isRecord(spec.fixtures)) throw invalid(name, 'fixtures must be an object');
    for (const [fixture, factory] of Object.entries(spec.fixtures)) {
      if (!FIXTURE_NAME_PATTERN.test(fixture)) {
        throw invalid(name, `fixture name "${fixture}" must be a lower-camel identifier`);
      }
      if (RESERVED_FIXTURES.has(fixture)) {
        throw invalid(name, `fixture name "${fixture}" shadows a universal fixture`);
      }
      if (typeof factory !== 'function') {
        throw invalid(name, `fixtures.${fixture} must be a factory function`);
      }
      capabilities.add(fixture);
    }
    // Bound like every other member, so a class-based engine keeps `this`
    // in its fixture factories too.
    handle['fixtures'] = Object.freeze(
      Object.fromEntries(
        Object.entries(spec.fixtures).map(([fixture, factory]) => [
          fixture,
          (factory as (...args: unknown[]) => unknown).bind(spec),
        ]),
      ),
    );
  }
  if (spec.keyboard !== undefined) {
    handle['keyboard'] = hookManifest(name, 'keyboard', spec.keyboard, ['type', 'press']);
    capabilities.add('keyboard');
  }
  if (spec.state !== undefined) {
    handle['state'] = hookManifest(name, 'state', spec.state, ['capture', 'restore']);
    capabilities.add('state');
  }
  if (spec.artifacts !== undefined) {
    const artifacts = hookManifest(name, 'artifacts', spec.artifacts, ['screenshot']);
    if ((artifacts['startTrace'] === undefined) !== (artifacts['stopTrace'] === undefined)) {
      throw invalid(name, 'artifacts.startTrace and stopTrace must be declared together');
    }
    if ((artifacts['startVideo'] === undefined) !== (artifacts['stopVideo'] === undefined)) {
      throw invalid(name, 'artifacts.startVideo and stopVideo must be declared together');
    }
    handle['artifacts'] = artifacts;
    capabilities.add('artifacts');
  }
  if (spec.app !== undefined) handle['app'] = appDeclaration(name, spec.app);
  if (spec.session !== undefined) handle['session'] = hookManifest(name, 'session', spec.session);

  // Assembled key by key above, so the record is an Engine by construction.
  return Object.freeze({
    ...handle,
    [engineBrand]: true as const,
    capabilities,
  }) as unknown as EngineHandle;
}

/** True for a defineEngine-branded handle, across realms. */
export function isEngineHandle(value: unknown): value is EngineHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[engineBrand] === true
  );
}
