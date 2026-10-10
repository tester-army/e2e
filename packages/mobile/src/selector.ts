/**
 * agent-device selector support for the `selector` locator expression:
 * `screen.locator('id=save role=button')` and the structural hint on every
 * observed node. Parsing and term rules are agent-device's own
 * (`parseSelectorChain`, `listSelectorChainMatches`); matching runs against
 * the projected snapshot, one immediate pass, every match returned, and
 * strictness stays with the runner.
 */

import type { SnapshotNode } from 'agent-device';
import { listSelectorChainMatches, parseSelectorChain } from 'agent-device/selectors';
import { EngineError } from 'e2e/engine';
import type { ProjectedNode } from './nodes.ts';
import type { MobilePlatform } from './options.ts';
import { message } from './errors.ts';

export type CompiledSelector = (entries: readonly ProjectedNode[]) => ProjectedNode[];

/**
 * Compiles one selector string for a platform. Alternatives (agent-device's
 * fallback chain) are tried in order and the first that matches anything
 * wins, with every node it matches returned in snapshot order.
 */
export function compileSelector(raw: string, platform: MobilePlatform): CompiledSelector {
  let chain: ReturnType<typeof parseSelectorChain>;
  try {
    chain = parseSelectorChain(raw);
  } catch (cause) {
    throw new EngineError('ENGINE_FAILURE', `invalid agent-device selector ${JSON.stringify(raw)}: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return (entries) => {
    const byNode = new Map<object, ProjectedNode>(entries.map((entry) => [entry.raw, entry]));
    // The projection types agent-device's nodes as partial for fixtures that omit fields; the term rules read only optional ones.
    const nodes = entries.map((entry) => entry.raw as SnapshotNode);
    const matched = listSelectorChainMatches(nodes, chain, { platform })?.matchedNodes ?? [];
    return matched.flatMap((node) => byNode.get(node) ?? []);
  };
}
