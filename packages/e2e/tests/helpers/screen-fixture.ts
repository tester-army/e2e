/**
 * The `screenOver` preset over a fixed node list, resolved with the
 * contract's reference semantics, so locator reads and `expect(locator)`
 * matchers can be exercised without a browser.
 */

import { resolveExpression, type SemanticNode } from 'e2e-core/lib/engine/index';
import type { Screen } from 'e2e-core/lib/types';
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
