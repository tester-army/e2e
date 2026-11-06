/** Which frames a locator expression descends through. */

import { EngineError, type LocatorExpression } from 'e2e/engine';

/** Returns every frame selector along an expression, outermost first. */
export function frameSelectors(expression: LocatorExpression): string[] {
  switch (expression.kind) {
    case 'union': {
      const left = frameSelectors(expression.left);
      const right = frameSelectors(expression.right);
      if (left.length !== right.length || left.some((selector, index) => selector !== right[index])) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'locator.or requires both branches in the same document', {
          retryable: false,
        });
      }
      return left;
    }
    case 'query':
      return expression.scope === undefined ? [] : frameSelectors(expression.scope);
    case 'filter': {
      const source = frameSelectors(expression.source);
      for (const inner of [expression.has, expression.hasNot]) {
        if (inner === undefined) continue;
        const chain = frameSelectors(inner);
        if (chain.length > 0 && (chain.length !== source.length || chain.some((selector, index) => selector !== source[index]))) {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'an inner has or hasNot locator must belong to the same frame as the locator it filters', { retryable: false });
        }
      }
      return source;
    }
    case 'index':
      return frameSelectors(expression.source);
    case 'selector':
      return [];
    case 'frame':
      return [expression.selector, ...frameSelectors(expression.source)];
  }
}
