/**
 * Binding templates to the run's ports: placeholders substituted, each
 * service keyed by what it runs, the free ports the run must assign, and
 * what enters the config digest.
 */

import { ConfigurationError } from '../../internal/errors.ts';
import { canonicalDigest } from '../../internal/ids.ts';
import { obj } from '../../internal/objects.ts';
import { portKey, replaceServiceTokens } from '../../internal/service-tokens.ts';
import type { ServiceAddresses } from '../../types.ts';
import { digestCommand, type Readiness } from '../command.ts';
import type { PortAssignments, PortRequest, ProcessTemplate, ResolvedService, ServiceTemplate } from './model.ts';
import { readCommand } from './template.ts';

/** One service's addresses as its placeholders read them. */
interface BoundAddress {
  readonly address: ServiceAddresses;
  readonly namedHost: string;
}

/** `value` with every placeholder replaced by the address `lookup` finds; the templates already checked each one exists. */
function bind(value: string, lookup: (service: string) => BoundAddress): string {
  return replaceServiceTokens(value, (token) => {
    const { address, namedHost } = lookup(token.service);
    if (token.port !== undefined) {
      const port = String(address.ports[token.port]);
      return token.kind === 'port' ? port : `${token.port}://${namedHost}:${port}`;
    }
    return token.kind === 'port' ? String(address.port) : address.url!;
  });
}

/** How placeholders read a resolved service. */
function boundAddress(service: ResolvedService): BoundAddress {
  return service.kind === 'process'
    ? { address: service.address, namedHost: service.template.namedHost }
    : { address: { url: undefined, port: undefined, ports: {} }, namedHost: '127.0.0.1' };
}

/** `value` with every placeholder replaced by the address of a service in `services`. */
export function bindTokens(value: string, services: ReadonlyMap<string, ResolvedService>): string {
  return bind(value, (name) => boundAddress(services.get(name)!));
}

/** A process's addresses on the run's ports: a free port not assigned yet reads 0. */
function addressOf(template: ProcessTemplate, ports: PortAssignments): ServiceAddresses {
  const assigned = (declared: number, port?: string): number => (declared === 0 ? (ports[portKey(template.name, port)] ?? 0) : declared);
  const named = Object.fromEntries(Object.entries(template.ports).map(([port, declared]) => [port, assigned(declared, port)]));
  const { primary } = template;
  if (primary === undefined) return { url: undefined, port: undefined, ports: named };
  const port = 'named' in primary.port ? named[primary.port.named]! : assigned(primary.port.number);
  return { url: new URL(`${primary.scheme}://${primary.host}:${port}`).origin, port, ports: named };
}

/**
 * Binds the templates, in start order, to the run's `ports`: every
 * placeholder substituted, and each service keyed by what it runs and the
 * keys of the services it depends on. Without ports, every free port reads
 * 0: the addresses as declared, which the identities key on.
 */
export function bindServices(templates: Iterable<ServiceTemplate>, ports: PortAssignments): ReadonlyMap<string, ResolvedService> {
  const bound = new Map<string, ResolvedService>();
  for (const template of templates) {
    const { name, label, role, dependencies } = template;
    const services = Object.fromEntries(dependencies.map((dependency) => [dependency, boundAddress(bound.get(dependency)!).address]));
    const dependencyKeys = dependencies.map((dependency) => bound.get(dependency)!.key);
    if (template.kind === 'function') {
      const key = canonicalDigest({ name, kind: 'function', dependencies: dependencyKeys });
      bound.set(name, { kind: 'function', name, label, role, dependencies, template, key, services });
      continue;
    }
    const address = addressOf(template, ports);
    const own: BoundAddress = { address, namedHost: template.namedHost };
    const read = (value: string): string => bind(value, (service) => (service === name ? own : boundAddress(bound.get(service)!)));
    const command = readCommand(template.command, label, read);
    const readiness: Readiness = template.readyUrl === undefined ? { waitForExit: true } : { readyUrl: new URL(read(template.readyUrl)).href };
    const teardown = template.teardown === undefined ? undefined : { label: `${label} teardown`, command: readCommand(template.teardown, label, read) };
    const key = canonicalDigest(obj({ name, kind: 'process', command, readiness, teardown: teardown?.command, dependencies: dependencyKeys }));
    bound.set(name, { kind: 'process', name, label, role, dependencies, template, key, services, command, readiness, teardown, address });
  }
  return bound;
}

/** The free ports the templates ask the run for: each process's primary one first, then its named ones. */
export function portRequests(templates: Iterable<ServiceTemplate>): readonly PortRequest[] {
  const requests: PortRequest[] = [];
  for (const template of templates) {
    if (template.kind !== 'process') continue;
    const { primary } = template;
    if (primary !== undefined && 'number' in primary.port && primary.port.number === 0) {
      requests.push({ key: portKey(template.name, undefined), host: primary.host, owner: template.label });
    }
    for (const [port, declared] of Object.entries(template.ports)) {
      if (declared === 0) requests.push({ key: portKey(template.name, port), host: template.namedHost, owner: template.label });
    }
  }
  return requests;
}

/**
 * Two processes probing one fixed address cannot both start: the second
 * finds the first answering (`APP_ALREADY_RUNNING`). One process several
 * targets share is one `defineService`.
 */
export function rejectSharedProbes(services: Iterable<ResolvedService>): void {
  const probes = new Map<string, string>();
  for (const service of services) {
    if (service.kind !== 'process' || !('readyUrl' in service.readiness)) continue;
    const { origin, port } = new URL(service.readiness.readyUrl);
    if (port === '0') continue;
    const other = probes.get(origin);
    if (other !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${other} and ${service.label} both probe ${origin}, so the second would find the first answering; one process several targets share is one service, const app = defineService({ name: 'app', executable, args, readyUrl }), listed as services: [app] with app: { url: app.url } on each target that opens it`,
      );
    }
    probes.set(origin, service.label);
  }
}

/** Every service a run's targets need, in start order, as it enters the config digest: env values by name, never the ports the run assigns. */
export function digestServices(services: Iterable<ResolvedService>) {
  return [...services].map(({ template }) =>
    template.kind === 'function'
      ? obj({ name: template.name, kind: 'function', dependencies: template.dependencies, startupTimeout: template.startupTimeout })
      : obj({
          name: template.name,
          kind: 'process',
          dependencies: template.dependencies,
          command: digestCommand(template.command),
          readyUrl: template.readyUrl,
          primary: template.primary,
          ports: template.ports,
          teardown: template.teardown === undefined ? undefined : digestCommand(template.teardown),
        }),
  );
}
