/** The frames a locator expression descends through, and the unions that cross documents. */

import { describe, expect, it } from 'vitest';
import type { LocatorExpression } from 'e2e/engine';
import { frameSelectors } from '../../src/locators.ts';

const textbox: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
};

describe('frameSelectors', () => {
  const inFrame = (selector: string): LocatorExpression => ({ kind: 'frame', selector, source: textbox });

  it('lists the frames along an expression, outermost first', () => {
    expect(frameSelectors({ kind: 'frame', selector: '#outer', source: inFrame('#inner') })).toEqual(['#outer', '#inner']);
    expect(frameSelectors({ kind: 'union', left: inFrame('#left'), right: inFrame('#left') })).toEqual(['#left']);
  });

  it('rejects a union whose branches live in different documents', () => {
    for (const right of [inFrame('#right'), textbox]) {
      expect(() => frameSelectors({ kind: 'union', left: inFrame('#left'), right })).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', retryable: false }),
      );
    }
  });
});
