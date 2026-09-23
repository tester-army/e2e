/**
 * The `screenOver` preset over a fixed node list, resolved with the
 * contract's reference semantics, so locator reads and `expect(locator)`
 * matchers can be exercised without a browser.
 */

import { resolveExpression, type SemanticNode } from '../../src/engine/index.ts';
import type { Screen } from '../../src/types.ts';
import { screenOver } from './screen-over.ts';
import { snapshot } from './snapshot.ts';

/** Action and assertion timeout of the fixture, short enough for failing-path tests. */
export const SCREEN_FIXTURE_TIMEOUT_MS = 300;

export function createScreenFixture(nodes: readonly SemanticNode[]): Screen {
  return screenOver({
    locate: (expression) => resolveExpression(expression, nodes),
    observe: () => snapshot(nodes),
    timeoutMs: SCREEN_FIXTURE_TIMEOUT_MS,
  }).screen;
}
