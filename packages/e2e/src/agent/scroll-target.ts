/**
 * Re-finding the node a scroll addresses.
 *
 * A scroll target is what sits where it sits more than what it says: a
 * device names a scroll view after its first visible row and renumbers the
 * tree on every look, so the id the model scrolled a moment ago may name
 * nothing on the newest screen and its descriptor may re-find nothing
 * either. The node of the same role whose box is the old box, near enough,
 * is the same list. A list that filled the screen and cannot be re-found at
 * all scrolls as the viewport does, which is what scrolling the main list
 * does; a smaller region that vanished is gone, as for any other action.
 */

import { MAIN_LIST_SHARE } from '../cache/locate.ts';
import { overlapShare, viewportShare, type Box } from '../internal/geometry.ts';
import type { ExecutorTarget } from './executor.ts';
import { nodeGone, type ObservationFeed, type Resolved } from './observation-feed.ts';
import type { RedactedNode, SemanticAgentObservation } from './observation.ts';

/**
 * How much of its old box a node must cover, and be covered by, to count as
 * the same list in a new place in the tree: enough that a carousel inside
 * the list never stands in for the list, nor the list for a carousel.
 */
const SAME_PLACE_OVERLAP = 0.5;

/**
 * The node a scroll target names now: the node itself, its descriptor's
 * match, or the same-role node in its old place. Undefined for a lost list
 * that filled the screen, which the caller scrolls as the viewport.
 */
export function resolveScrollTarget(feed: ObservationFeed, target: ExecutorTarget): Resolved | undefined {
  const { id, node, observation } = feed.lookup(target);
  if (node !== undefined) return { node, observation };
  const seen = feed.lastSeen(id);
  const box = seen?.node.rect;
  if (seen === undefined || box === undefined) throw nodeGone(id, observation);
  const again = samePlace(observation, seen.node.role, box);
  if (again !== undefined) return { node: again, observation };
  if (viewportShare(box, seen.observation.viewport) >= MAIN_LIST_SHARE) return undefined;
  throw nodeGone(id, observation);
}

/** The listed node of the role whose box overlaps `box` most, when it overlaps enough. */
export function samePlace(observation: SemanticAgentObservation, role: string | undefined, box: Box): RedactedNode | undefined {
  let best: { node: RedactedNode; overlap: number } | undefined;
  for (const node of observation.nodes.values()) {
    if (node.role !== role || node.rect === undefined || node.states?.hidden === true) continue;
    const overlap = overlapShare(node.rect, box);
    if (overlap >= SAME_PLACE_OVERLAP && (best === undefined || overlap > best.overlap)) best = { node, overlap };
  }
  return best?.node;
}
