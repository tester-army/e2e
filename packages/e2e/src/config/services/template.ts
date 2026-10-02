/**
 * Checking services into templates: every string holds tokens, `{port}` is
 * the process's own port, and every placeholder names an address the process
 * may read.
 */

import { ConfigurationError } from '../../internal/errors.ts';
import { obj } from '../../internal/objects.ts';
import { serviceTokens, tokenOf, type ServiceToken } from '../../internal/service-tokens.ts';
import { didYouMean } from '../../internal/suggest.ts';
import { isLoopbackAddress, portOf, type NormalizedBaseUrl } from '../../internal/urls.ts';
import type { CommandConfig } from '../../types.ts';
import { checkLog } from '../command.ts';
import { httpUrl } from '../validate.ts';
import type { CollectedServices } from './collect.ts';
import type { PrimaryAddress, ProcessTemplate, ServiceTemplate, TemplateBase } from './model.ts';

/** A function service's `start` budget when it names none, a process's `startupTimeout` default. */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** `{port}` and `{port:<name>}`: a process's own ports, as its declaration writes them. */
const OWN_PORT_PATTERN = /\{port(?::([^}]*))?\}/g;

/** The templates of every collected service, in start order. */
export function serviceTemplates(collected: CollectedServices, projectRoot: string): Map<string, ServiceTemplate> {
  const templates = new Map<string, ServiceTemplate>();
  for (const definition of collected.definitions) {
    const { name } = definition;
    const label = `service "${name}"`;
    const dependencies = collected.dependencies.get(name) ?? [];
    if (definition.kind === 'function') {
      const { start, stop, startupTimeout } = definition;
      templates.set(name, { kind: 'function', name, label, role: 'service', dependencies, start, stop, startupTimeout: startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS });
      continue;
    }
    templates.set(
      name,
      processTemplate(
        {
          name,
          label,
          role: 'service',
          where: label,
          readyWhere: `${label}.readyUrl`,
          command: definition.command,
          readyUrl: definition.readyUrl,
          ports: definition.ports,
          teardown: definition.teardown,
          serves: undefined,
          dependencies,
        },
        templates,
        projectRoot,
      ),
    );
  }
  return templates;
}

/**
 * One process to check into a template: a service's definition, or a target's
 * `app.command`. It may read the addresses of its `dependencies` only.
 */
export interface ProcessSpec extends TemplateBase, Pick<ProcessTemplate, 'command' | 'readyUrl' | 'teardown' | 'ports'> {
  /** The config path of its command, for errors: `service "db"`, `target "web" app.command`. */
  readonly where: string;
  /** The config path of its readiness URL. */
  readonly readyWhere: string;
  /** The address it serves when that is not its `readyUrl`: a target's `app.url`, whose port `{port}` then means. */
  readonly serves: NormalizedBaseUrl | undefined;
}

/** A readiness URL's authority, parsed once: its scheme, its host, and what its port is. */
interface ReadyAuthority {
  readonly scheme: string;
  readonly host: string;
  readonly port: { readonly number: number } | { readonly named: string } | 'own';
  /** Everything before the port. */
  readonly head: string;
  /** Everything after it. */
  readonly rest: string;
}

/**
 * Parses a readiness URL: an absolute http(s) URL whose port is a number
 * (0 for a free one), `{port:<name>}`, `{port}`, or the scheme's default.
 */
function parseReadyUrl(raw: string, where: string): ReadyAuthority {
  const match = /^(https?):\/\/(\[[^\]]*\]|[^/?#:]*)(?::(\{port(?::[^}]*)?\}|\d*))?/i.exec(raw);
  httpUrl(raw.replace(OWN_PORT_PATTERN, '1'), where);
  if (match === null || match[2] === '') throw new ConfigurationError('INVALID_CONFIG', `${where} must be an http(s) URL`);
  const [head, scheme, host, port] = match;
  const hostname = new URL(`${scheme!}://${host!}`).hostname;
  const rest = raw.slice(head.length);
  const authority = { scheme: scheme!.toLowerCase(), host: hostname, head: `${scheme!}://${host!}`, rest };
  if (port === undefined || port === '') return { ...authority, port: { number: scheme!.toLowerCase() === 'https' ? 443 : 80 } };
  if (port === '{port}') return { ...authority, port: 'own' };
  if (port.startsWith('{')) return { ...authority, port: { named: port.slice('{port:'.length, -1) } };
  return { ...authority, port: { number: Number(port) } };
}

/**
 * Checks one process into its template. Its primary address comes from
 * `serves` (an app command's URL) or else its `readyUrl`; `{port}` is that
 * address's port and `{port:<name>}` one of its named ports, both rewritten
 * to its own placeholders, so every string reads addresses one way. A
 * placeholder must name a service in scope and an address that service has.
 * A process with a free port cannot `reuseExisting`: what already answers
 * does not serve the port the run assigns.
 */
export function processTemplate(spec: ProcessSpec, templates: ReadonlyMap<string, ServiceTemplate>, projectRoot: string): ProcessTemplate {
  const { name, label, where, readyWhere } = spec;
  const foreign = serviceTokens(spec.readyUrl ?? '').find((token) => token.service !== name);
  if (foreign !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${readyWhere} is where ${label} is probed, its own address, so it cannot be service "${foreign.service}"'s`,
    );
  }
  const authority = spec.readyUrl === undefined ? undefined : parseReadyUrl(spec.readyUrl, readyWhere);
  let primary: PrimaryAddress | undefined;
  let readyUrl = spec.readyUrl;
  if (spec.serves !== undefined) {
    if (authority !== undefined && typeof authority.port === 'object' && 'number' in authority.port && authority.port.number === 0) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${readyWhere} asks for a free port (port 0), but ${label} is served at ${spec.serves.origin}: write {port} for its port, or the port itself`,
      );
    }
    const served = new URL(spec.serves.href);
    primary = { scheme: served.protocol.slice(0, -1), host: served.hostname, port: { number: portOf(spec.serves) } };
  } else if (authority !== undefined) {
    const { scheme, host, port } = authority;
    if (port === 'own') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${readyWhere} uses {port}, but ${label} has no other address to take the port from: write port 0 there for a free one (http://127.0.0.1:0/health), or name a port of ports as {port:name}`,
      );
    }
    if ('number' in port && port.number === 0) {
      if (!isLoopbackAddress(host)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `${readyWhere} asks for a free port on ${host}, which takes only a literal loopback address the process will bind, 127.0.0.1 or [::1]`,
        );
      }
      readyUrl = `${authority.head}:{port}${authority.rest}`;
    }
    primary = { scheme, host, port };
  }
  // `{port}` names a port only where the process's own address asks for a
  // free one, or the address it serves fixes it; a fixed readyUrl port is
  // written as the number it is.
  const ownPort = (at: string): string => {
    if (primary === undefined || (spec.serves === undefined && 'named' in primary.port)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${at} uses {port}, but ${label} asks for no free port: give it one with readyUrl: 'http://127.0.0.1:0', or name its ports in ports and write {port:name}`,
      );
    }
    if (spec.serves === undefined && 'number' in primary.port && primary.port.number !== 0) {
      throw new ConfigurationError('INVALID_CONFIG', `${at} uses {port}, but ${label} has the fixed port ${primary.port.number}: write it directly`);
    }
    return tokenOf(name, 'port');
  };
  const self: ProcessTemplate = {
    kind: 'process',
    name,
    label,
    role: spec.role,
    dependencies: spec.dependencies,
    command: spec.command,
    readyUrl: undefined,
    teardown: undefined,
    primary,
    ports: spec.ports,
    namedHost: primary !== undefined && isLoopbackAddress(primary.host) ? primary.host : '127.0.0.1',
  };
  const read = (value: string, at: string): string => {
    const own = value.replace(OWN_PORT_PATTERN, (_token, port: string | undefined) => {
      if (port === undefined) {
        return ownPort(at);
      }
      if (spec.ports[port] === undefined) throw unknownNamedPort(at, label, port, spec.ports);
      return tokenOf(name, 'port', port);
    });
    for (const token of serviceTokens(own)) {
      if (token.service === name) checkAddress(self, token, at);
      else checkScopedAddress(token, at, spec.dependencies, templates, `which ${label} does not depend on: a service lists it in dependsOn, a target in services`);
    }
    return own;
  };
  const command = readCommand(spec.command, where, read);
  const teardown = spec.teardown === undefined ? undefined : readCommand(spec.teardown, `${where}.teardown`, read);
  checkLog(command, where, projectRoot);
  if (teardown !== undefined) checkLog(teardown, `${where}.teardown`, projectRoot);
  const onFreePort = (primary !== undefined && 'number' in primary.port && primary.port.number === 0) || Object.values(spec.ports).includes(0);
  if (command.reuseExisting === true && onFreePort) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where}.reuseExisting cannot find ${label} already running on a free port: port 0 is a new port every run; give it a fixed port, or drop reuseExisting`,
    );
  }
  return { ...self, command, teardown, readyUrl: readyUrl === undefined ? undefined : read(readyUrl, readyWhere) };
}

/** A command with every args entry and env value mapped through `read`, told where each came from. */
export function readCommand(command: CommandConfig, where: string, read: (value: string, at: string) => string): CommandConfig {
  const { args, env } = command;
  return obj({
    ...command,
    args: args?.map((arg) => read(arg, `${where}.args`)),
    env: env === undefined ? undefined : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, read(value, `${where}.env.${key}`)])),
  });
}

/** `{port:<name>}` for a port the process does not declare. */
function unknownNamedPort(at: string, label: string, port: string, ports: Readonly<Record<string, number>>): ConfigurationError {
  const declared = Object.keys(ports);
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${at} uses {port:${port}}, but ${label} declares no port "${port}"${declared.length === 0 ? '' : `; its ports are ${declared.join(', ')}${didYouMean(port, declared)}`}`,
  );
}

/**
 * Refuses a placeholder for an address `service` does not have: a function
 * service has none, a process without a `readyUrl` no primary one, and a
 * port name must be one it declares.
 */
function checkAddress(service: ServiceTemplate, token: ServiceToken, at: string): void {
  const described = `${at} uses ${token.token}`;
  if (service.kind === 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `${described}, but service "${service.name}" is a function and has no address`);
  }
  if (token.port !== undefined) {
    if (service.ports[token.port] !== undefined) return;
    const declared = Object.keys(service.ports);
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${described}, but service "${service.name}" declares no port "${token.port}"${
        declared.length === 0 ? '; declare it in ports' : `; its ports are ${declared.join(', ')}${didYouMean(token.port, declared)}`
      }`,
    );
  }
  if (service.primary === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${described}, but service "${service.name}" has no primary address: it comes from its readyUrl; read a named port with ${token.kind}Of('name')`,
    );
  }
}

/**
 * Refuses a placeholder for a service outside `scope`, with `outside` saying
 * whose scope, or for an address that service does not have.
 */
function checkScopedAddress(
  token: ServiceToken,
  at: string,
  scope: readonly string[],
  templates: ReadonlyMap<string, ServiceTemplate>,
  outside: string,
): void {
  const service = scope.includes(token.service) ? templates.get(token.service) : undefined;
  if (service === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${at} uses the address of service "${token.service}", ${outside}`);
  }
  checkAddress(service, token, at);
}

/**
 * Checks the placeholders one target string holds (`app.url`): each names a
 * service of the target's graph and an address that service has.
 */
export function checkTargetTokens(
  value: string,
  at: string,
  targetName: string,
  graph: readonly string[],
  templates: ReadonlyMap<string, ServiceTemplate>,
): void {
  for (const token of serviceTokens(value)) {
    checkScopedAddress(token, at, graph, templates, `which target "${targetName}" does not list; add it to the target's services`);
  }
}
