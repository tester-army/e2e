/**
 * `defineService`: the one identity of a process or a function a run needs
 * beside the app, and the address placeholders read off it. The handle
 * carries its options checked and normalized once, into the definition the
 * config resolution reads (`config/services/`); what needs the project
 * root, the other services, or the run's ports is checked there.
 */

import { COMMAND_KEYS, isRecord, normalizeCommand } from './config/command.ts';
import { positiveInt } from './config/validate.ts';
import { serviceBrand } from './internal/brands.ts';
import { ConfigurationError } from './internal/errors.ts';
import { PORT_NAME_PATTERN, SERVICE_NAME_PATTERN, tokenOf } from './internal/service-tokens.ts';
import { unknownKeyMessage } from './internal/options.ts';
import type {
  CommandConfig,
  FunctionServiceOptions,
  ProcessServiceOptions,
  ServiceContext,
  ServiceHandle,
  ServiceOptions,
} from './types.ts';

/** The longest `name` a service may carry; a label, not a description. */
const SERVICE_NAME_MAX_LENGTH = 64;

/** The keys of a process service: a command's, plus what steers the service. */
const PROCESS_KEYS: readonly string[] = [
  ...COMMAND_KEYS,
  ...Object.keys({
    name: true,
    dependsOn: true,
    readyUrl: true,
    waitForExit: true,
    ports: true,
    teardown: true,
  } satisfies Record<Exclude<keyof ProcessServiceOptions, keyof CommandConfig | 'start' | 'stop'>, true>),
];

/** The keys of a function service. */
const FUNCTION_KEYS: readonly string[] = Object.keys({
  name: true,
  dependsOn: true,
  start: true,
  stop: true,
  startupTimeout: true,
} satisfies Record<Exclude<keyof FunctionServiceOptions, 'executable' | 'readyUrl' | 'waitForExit' | 'ports' | 'teardown'>, true>);

interface DefinitionBase {
  readonly name: string;
  /** The services it depends on directly, each defined before it. */
  readonly dependsOn: readonly ServiceHandle[];
}

/** A process service as `defineService` normalized it: every placeholder read as its token. */
export interface ProcessDefinition extends DefinitionBase {
  readonly kind: 'process';
  readonly command: CommandConfig;
  readonly readyUrl: string | undefined;
  readonly ports: Readonly<Record<string, number>>;
  readonly teardown: CommandConfig | undefined;
}

/** A function service as `defineService` normalized it. */
export interface FunctionDefinition extends DefinitionBase {
  readonly kind: 'function';
  readonly start: (context: ServiceContext) => Promise<void>;
  readonly stop: ((context: ServiceContext) => Promise<void>) | undefined;
  readonly startupTimeout: number | undefined;
}

export type ServiceDefinition = ProcessDefinition | FunctionDefinition;

/** A `defineService` refusal, `INVALID_CONFIG` like every config error. */
function invalid(detail: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `defineService: ${detail}`);
}

/** The placeholder for one named port of `service`, checked to be a port name. */
function namedToken(service: string, kind: 'url' | 'port', port: string): string {
  if (typeof port !== 'string' || !PORT_NAME_PATTERN.test(port)) {
    throw invalid(`service "${service}" ${kind}Of(${JSON.stringify(port)}) names no port; a port name is a lowercase scheme such as "http" or "smtp"`);
  }
  return tokenOf(service, kind, port);
}

/** Whether a value is a `defineService` handle, from this module instance or another realm's. */
export function isServiceHandle(value: unknown): value is ServiceHandle {
  return typeof value === 'object' && value !== null && isRecord((value as Record<PropertyKey, unknown>)[serviceBrand]);
}

/** What a handle was defined with, normalized; only a handle reaches here. */
export function serviceDefinition(handle: ServiceHandle): ServiceDefinition {
  return (handle as unknown as Record<typeof serviceBrand, ServiceDefinition>)[serviceBrand];
}

/**
 * Why a value in a `services` or `dependsOn` list is not a service: a plain
 * object (the old service shape), a spread copy of a handle, or anything else.
 */
export function notAServiceHandle(value: unknown, where: string): ConfigurationError {
  const described = isRecord(value)
    ? typeof value['name'] === 'string' && typeof value['urlOf'] === 'function'
      ? `a copy of service "${value['name']}"; a spread copy is not the service, so list the handle defineService returned`
      : 'a plain object; wrap it in defineService({ name, executable, ... }) and list the handle it returns'
    : `${value === null ? 'null' : typeof value}; list the handle defineService({ name, ... }) returns`;
  return new ConfigurationError('INVALID_CONFIG', `${where} is ${described}`);
}

/** The process form, checked and normalized: its command, readiness contract, ports, and teardown. */
function processDefinition(options: ProcessServiceOptions, where: string): Omit<ProcessDefinition, keyof DefinitionBase> {
  const { name: _name, dependsOn: _dependsOn, readyUrl, waitForExit, ports, teardown, ...commandOptions } = options;
  const command = normalizeCommand(commandOptions, where);
  if (readyUrl !== undefined && typeof readyUrl !== 'string') {
    throw invalid(`${where}.readyUrl must be a string: it is the service's own address, never another service's placeholder`);
  }
  if (waitForExit !== undefined && typeof waitForExit !== 'boolean') throw invalid(`${where}.waitForExit must be a boolean`);
  if ((readyUrl !== undefined) === (waitForExit === true)) {
    throw invalid(`${where} needs exactly one readiness contract: set readyUrl or waitForExit: true`);
  }
  if (readyUrl === undefined && command.reuseExisting !== undefined) {
    throw invalid(`${where}.reuseExisting needs readyUrl: a waitForExit service has nothing to reuse`);
  }
  if (ports !== undefined && !isRecord(ports)) throw invalid(`${where} ports must be an object of port name to port number`);
  for (const [port, value] of Object.entries(ports ?? {})) {
    if (!PORT_NAME_PATTERN.test(port)) throw invalid(`${where} ports.${port}: a port name is a lowercase scheme such as "http" or "smtp"`);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65_535) {
      throw invalid(`${where} ports.${port} must be 0 for a free port, or a port number, got ${JSON.stringify(value)}`);
    }
  }
  const teardownCommand = teardown === undefined ? undefined : normalizeCommand(teardown, `${where}.teardown`);
  if (teardownCommand?.reuseExisting !== undefined) {
    throw invalid(`${where}.teardown.reuseExisting needs readyUrl: a teardown command has nothing to reuse`);
  }
  return {
    kind: 'process',
    command,
    readyUrl,
    ports: Object.freeze({ ...ports }),
    teardown: teardownCommand,
  };
}

/**
 * Declares one service the run starts before the first test and stops at
 * the end: a process (`executable`, with `readyUrl` or `waitForExit`) or a
 * function (`start`, optionally `stop`), never both. Returns a frozen handle
 * to list in a target's `services` and in another service's `dependsOn`, and
 * to read address placeholders from. The options are checked and copied
 * here, so a list changed afterwards changes nothing, and a dependency is a
 * handle that already exists, so services never depend on each other in a
 * cycle.
 */
export function defineService(options: ServiceOptions): ServiceHandle {
  if (!isRecord(options)) throw invalid('takes an options object: { name, executable, ... } or { name, start }');
  const { name } = options;
  if (typeof name !== 'string' || !SERVICE_NAME_PATTERN.test(name) || name.length > SERVICE_NAME_MAX_LENGTH) {
    throw invalid(
      `name is required: ASCII letters, digits, "_", and "-", at most ${SERVICE_NAME_MAX_LENGTH} characters, got ${JSON.stringify(name)}`,
    );
  }
  const where = `service "${name}"`;
  const isProcess = options.executable !== undefined;
  const isFunction = options.start !== undefined || options.stop !== undefined;
  if (isProcess && isFunction) {
    throw invalid(`${where} is both a process (executable) and a function (start, stop); a service is one or the other`);
  }
  if (!isProcess && !isFunction) throw invalid(`${where} needs executable for a process, or start for a function`);
  const keys = isProcess ? PROCESS_KEYS : FUNCTION_KEYS;
  const other = isProcess ? FUNCTION_KEYS : PROCESS_KEYS;
  const crossed = Object.getOwnPropertyNames(options).find((key) => !keys.includes(key) && other.includes(key));
  if (crossed !== undefined) {
    throw invalid(`${where} has unknown key "${crossed}"; ${crossed} belongs to a ${isProcess ? 'function' : 'process'} service, and a service is one or the other`);
  }
  const unknown = unknownKeyMessage(where, options, keys);
  if (unknown !== undefined) throw invalid(unknown);
  const dependsOn: unknown = options.dependsOn ?? [];
  if (!Array.isArray(dependsOn)) throw invalid(`${where} dependsOn must be an array of services`);
  dependsOn.forEach((dependency: unknown, index) => {
    if (!isServiceHandle(dependency)) throw notAServiceHandle(dependency, `${where} dependsOn[${index}]`);
  });
  const base = { name, dependsOn: Object.freeze([...(dependsOn as ServiceHandle[])]) };
  let definition: ServiceDefinition;
  if (options.executable !== undefined) {
    definition = { ...base, ...processDefinition(options, where) };
  } else {
    const { start, stop, startupTimeout } = options;
    if (typeof start !== 'function') throw invalid(`${where} start must be a function`);
    if (stop !== undefined && typeof stop !== 'function') throw invalid(`${where} stop must be a function`);
    definition = { ...base, kind: 'function', start, stop, startupTimeout: positiveInt(startupTimeout, `${where}.startupTimeout`, 'milliseconds') };
  }
  const handle: Omit<ServiceHandle, typeof serviceBrand> = {
    name,
    url: tokenOf(name, 'url'),
    port: tokenOf(name, 'port'),
    urlOf: (port) => namedToken(name, 'url', port),
    portOf: (port) => namedToken(name, 'port', port),
  };
  Object.defineProperty(handle, serviceBrand, { value: Object.freeze(definition), enumerable: false });
  return Object.freeze(handle) as unknown as ServiceHandle;
}
