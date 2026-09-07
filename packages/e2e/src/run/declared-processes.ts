/**
 * The processes a run owns, gathered from every target's engine declaration
 * (spec 05-config.md). Declarations are deduplicated across targets, so two
 * browsers on one dev server share one process and one set of services, and
 * the merged order is checked for consistency before anything spawns.
 */

import type { ResolvedService } from '../config/app.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import type { CommandConfig } from '../types.ts';

/** One app command to start, named after the first target that declared it. */
export interface DeclaredCommand {
  readonly label: string;
  readonly command: CommandConfig;
  /** The readiness probe of the first declaring target; a shared server is up when it answers. */
  readonly readyUrl: string;
}

export interface DeclaredProcesses {
  /** Every distinct service in start order: target order, first declaration wins. */
  readonly services: readonly ResolvedService[];
  /** Every distinct command; identity is the command alone, not where it is probed. */
  readonly commands: readonly DeclaredCommand[];
}

/** Two services are the same process when they spawn and settle the same way; names and labels do not count. */
function serviceKey(service: ResolvedService): string {
  return canonicalDigest(
    obj({ command: service.command, readiness: service.readiness, teardown: service.teardown?.command }),
  );
}

/**
 * Gathers and deduplicates the declared services and commands. Services keep
 * target order; a target whose declaration orders two shared services the
 * other way round is `INVALID_CONFIG`, as is one explicit service name on two
 * different services, so a failure message never points at the wrong process.
 */
export function declaredProcesses(targets: readonly ResolvedTarget[]): DeclaredProcesses {
  const services: ResolvedService[] = [];
  const owners: string[] = [];
  const indexByKey = new Map<string, number>();
  const keyByName = new Map<string, string>();
  const commands: DeclaredCommand[] = [];
  const commandKeys = new Set<string>();

  for (const target of targets) {
    let last = -1;
    for (const service of target.app.services) {
      const key = serviceKey(service);
      let index = indexByKey.get(key);
      if (index === undefined) {
        index = services.length;
        services.push(service);
        owners.push(target.name);
        indexByKey.set(key, index);
        if (service.name !== undefined) {
          const taken = keyByName.get(service.name);
          if (taken !== undefined) {
            throw new ConfigurationError(
              'INVALID_CONFIG',
              `${service.label} is declared by target "${target.name}" and by target "${owners[indexByKey.get(taken)!]!}" with different commands; an explicit service name must mean one process across the run`,
            );
          }
          keyByName.set(service.name, key);
        }
      } else if (index < last) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `target "${target.name}" declares ${service.label} after ${services[last]!.label}, but target "${owners[index]!}" declares them the other way round; shared services must be declared in one order`,
        );
      }
      last = index;
    }

    const { command, readyUrl } = target.app;
    if (command === undefined || readyUrl === undefined) continue;
    const key = canonicalDigest(command);
    if (commandKeys.has(key)) continue;
    commandKeys.add(key);
    commands.push({ label: `target "${target.name}" command`, command, readyUrl });
  }
  return { services, commands };
}
