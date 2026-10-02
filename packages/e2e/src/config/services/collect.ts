/** The services every target's graph holds, in one start order for the run. */

import { ConfigurationError } from '../../internal/errors.ts';
import { isServiceHandle, notAServiceHandle, serviceDefinition, type ServiceDefinition } from '../../services.ts';
import type { ServiceHandle } from '../../types.ts';

/** The services every target's graph holds, in start order, and each target's own graph. */
export interface CollectedServices {
  /** Dependencies first, in target order, each target's list in order. */
  readonly definitions: readonly ServiceDefinition[];
  /** Each service's dependencies, direct or through another, in start order. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** Each target's services and every one they depend on, in start order. */
  readonly graphs: ReadonlyMap<string, readonly string[]>;
}

/**
 * Collects the services each target lists and every service they depend on,
 * in one start order for the run: target order, each target's list in order,
 * every service after the services it depends on. A value that is not a
 * handle and two handles with one name are `INVALID_CONFIG`. A dependency is
 * a handle defined before its dependent, so the graph has no cycle.
 */
export function collectServices(targets: readonly { readonly name: string; readonly services: unknown }[]): CollectedServices {
  const handles = new Map<string, ServiceHandle>();
  const closures = new Map<string, ReadonlySet<string>>();
  const ordered: ServiceDefinition[] = [];
  const visit = (handle: ServiceHandle): ReadonlySet<string> => {
    const known = handles.get(handle.name);
    if (known !== undefined && known !== handle) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `two services are named "${handle.name}"; a name is one service across the run, so define it once with defineService and list that handle everywhere it is needed`,
      );
    }
    const visited = closures.get(handle.name);
    if (visited !== undefined) return visited;
    handles.set(handle.name, handle);
    const definition = serviceDefinition(handle);
    const closure = new Set<string>();
    for (const dependency of definition.dependsOn) {
      for (const name of visit(dependency)) closure.add(name);
      closure.add(dependency.name);
    }
    closures.set(handle.name, closure);
    ordered.push(definition);
    return closure;
  };
  const listed = targets.map(({ name, services }) => {
    if (services === undefined) return [name, new Set<string>()] as const;
    if (!Array.isArray(services)) {
      throw new ConfigurationError('INVALID_CONFIG', `target "${name}" services must be an array of defineService handles`);
    }
    const graph = new Set<string>();
    services.forEach((handle: unknown, index) => {
      if (!isServiceHandle(handle)) throw notAServiceHandle(handle, `target "${name}" services[${index}]`);
      for (const dependency of visit(handle)) graph.add(dependency);
      graph.add(handle.name);
    });
    return [name, graph] as const;
  });
  const position = new Map(ordered.map((definition, index) => [definition.name, index]));
  const inOrder = (names: Iterable<string>): readonly string[] => [...names].toSorted((a, b) => position.get(a)! - position.get(b)!);
  return {
    definitions: ordered,
    dependencies: new Map([...closures].map(([name, closure]) => [name, inOrder(closure)])),
    graphs: new Map(listed.map(([name, graph]) => [name, inOrder(graph)])),
  };
}
