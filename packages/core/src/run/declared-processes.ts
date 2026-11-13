/**
 * The app commands a run owns, gathered from every target's `app`.
 * Declarations are deduplicated across targets, so two browsers on one dev
 * server share one process.
 */

import type { ResolvedTarget } from '../config/resolve.ts';
import { canonicalDigest } from '../internal/ids.ts';
import type { CommandConfig } from '../types.ts';

/** One app command to start, named after the first target that declared it. */
export interface DeclaredCommand {
  readonly label: string;
  readonly command: CommandConfig;
  /** The readiness probe of the first declaring target; a shared server is up when it answers. */
  readonly readyUrl: string;
  /** The command's identity: how it spawns, not where it is probed. A URL declared with port 0 spawns with its allocated port, so each allocation is its own. */
  readonly key: string;
  /** Every target whose work depends on this command. */
  readonly targetNames: readonly string[];
}

/** Every distinct app command in target order; identity is the command alone, not where it is probed. */
export function declaredCommands(targets: readonly ResolvedTarget[]): readonly DeclaredCommand[] {
  const commands = new Map<string, DeclaredCommand & { targetNames: string[] }>();
  for (const target of targets) {
    const { command, readyUrl } = target.app;
    if (command === undefined || readyUrl === undefined) continue;
    const key = canonicalDigest(command);
    const existing = commands.get(key);
    if (existing !== undefined) existing.targetNames.push(target.name);
    else commands.set(key, { label: `target "${target.name}" command`, command, readyUrl, key, targetNames: [target.name] });
  }
  return [...commands.values()];
}
