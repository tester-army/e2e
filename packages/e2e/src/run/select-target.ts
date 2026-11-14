/** The target a session opens: named, or the only one the config declares. */

import type { ResolvedConfig, ResolvedTarget } from 'e2e-core/lib/config/resolve';
import { ConfigurationError } from 'e2e-core/lib/internal/errors';

/**
 * `name` must be a declared target; without one, the config must declare
 * exactly one. `howToName` tells the caller how to name it when several exist.
 */
export function selectTarget(config: ResolvedConfig, name: string | undefined, howToName: string): ResolvedTarget {
  const names = config.targets.map((target) => `"${target.name}"`).join(', ');
  if (name !== undefined) {
    const target = config.targets.find((candidate) => candidate.name === name);
    if (target === undefined) throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${name}"; the config declares ${names}`);
    return target;
  }
  const [only] = config.targets;
  if (only === undefined) throw new ConfigurationError('INVALID_CONFIG', 'the config declares no targets');
  if (config.targets.length > 1) throw new ConfigurationError('TARGET_REQUIRED', `the config declares several targets (${names}); ${howToName}`);
  return only;
}
