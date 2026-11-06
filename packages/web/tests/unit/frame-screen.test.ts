/**
 * `browser.frameLocator` returns a frame-scoped screen that keeps the web-only
 * escape hatches: `locator` for an unnamed control inside the frame and
 * `frameLocator` for a frame nested in it. Both compose the same `frame`
 * expression every query in that scope compiles through.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, LocatorExpression } from 'e2e/engine';
import type { Locator, Screen } from 'e2e';
import type { BidiSurface } from '../../src/bidi/surface.ts';
import { createBidiBrowserFixture } from '../../src/bidi/browser.ts';
import { ErrorLatch } from '../../src/support.ts';

function browserWithRecordingContext() {
  const minted: LocatorExpression[] = [];
  const context = {
    timeouts: { test: 30_000, action: 1_000, assertion: 1_000 },
    operation: () => ({ signal: new AbortController().signal, timeoutMs: 1_000, runId: 'r', attemptId: 'a', origin: 'test' }),
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
    locator: (expression: LocatorExpression) => {
      minted.push(expression);
      return { minted: expression } as unknown as Locator;
    },
    screen: (scope: (expression: LocatorExpression) => LocatorExpression) => {
      return {
        getByRole: (role: string) =>
          ({
            minted: scope({
              kind: 'query',
              query: { kind: 'role', value: { kind: 'string', value: role, exact: true } },
            }),
          }) as unknown as Locator,
      } as unknown as Screen;
    },
  } as unknown as EngineFixtureContext;
    // The frame scopes mint locators only; the surface is never driven.
  const surface = { attemptScope: () => ({ latch: new ErrorLatch() }) } as unknown as BidiSurface;
  const browser = createBidiBrowserFixture(surface, context);
  return { browser, minted };
}

const minted = (locator: Locator): LocatorExpression => (locator as unknown as { minted: LocatorExpression }).minted;

describe('frame screen', () => {
  it('frameLocator nests outermost-first', () => {
    const { browser } = browserWithRecordingContext();
    const inner = browser.frameLocator('#outer').frameLocator('#inner');
    expect(minted(inner.locator('#drag1'))).toEqual({
      kind: 'frame',
      selector: '#outer',
      source: { kind: 'frame', selector: '#inner', source: { kind: 'selector', selector: '#drag1' } },
    });
    expect(minted(inner.getByRole('button'))).toEqual({
      kind: 'frame',
      selector: '#outer',
      source: {
        kind: 'frame',
        selector: '#inner',
        source: { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      },
    });
  });

  it('rejects an empty selector at every level', () => {
    const { browser } = browserWithRecordingContext();
    const frame = browser.frameLocator('#result');
    expect(() => browser.frameLocator('')).toThrow(/browser\.frameLocator\(\) requires a nonempty selector/);
    expect(() => frame.locator('')).toThrow(/^locator\(\) requires a nonempty selector/);
    expect(() => frame.frameLocator('')).toThrow(/^frameLocator\(\) requires a nonempty selector/);
  });
});
