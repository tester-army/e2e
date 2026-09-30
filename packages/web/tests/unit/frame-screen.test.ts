/**
 * `browser.frameLocator` returns a frame-scoped screen that keeps the web-only
 * escape hatches: `locator` for an unnamed control inside the frame and
 * `frameLocator` for a frame nested in it. Both compose the same `frame`
 * expression every query in that scope compiles through.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, LocatorExpression } from 'e2e/engine';
import type { Locator, Screen } from 'e2e';
import type { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture } from '../../src/browser.ts';

function browserWithRecordingContext() {
  const minted: LocatorExpression[] = [];
  const context = {
    operation: () => ({ signal: new AbortController().signal, timeoutMs: 1_000, runId: 'r', attemptId: 'a', origin: 'test' }),
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
    locator: (expression: LocatorExpression) => {
      minted.push(expression);
      return { minted: expression } as unknown as Locator;
    },
    screen: (scope: (expression: LocatorExpression) => LocatorExpression) => {
      const screen = {
        getByRole: (role: string) =>
          ({
            minted: scope({
              kind: 'query',
              query: { kind: 'role', value: { kind: 'string', value: role, exact: true } },
            }),
          }) as unknown as Locator,
      } as unknown as Screen;
      screens.push(screen);
      return screen;
    },
  } as unknown as EngineFixtureContext;
  const screens: Screen[] = [];
  const browser = createBrowserFixture({} as PlaywrightSurface, context);
  return { browser, minted, screens };
}

const minted = (locator: Locator): LocatorExpression => (locator as unknown as { minted: LocatorExpression }).minted;

describe('frame screen', () => {
  it('keeps the screen queries scoped to the frame', () => {
    const { browser } = browserWithRecordingContext();
    expect(minted(browser.frameLocator('#result').getByRole('button'))).toEqual({
      kind: 'frame',
      selector: '#result',
      source: { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
    });
  });

  it('locator resolves a native selector inside the frame', () => {
    const { browser } = browserWithRecordingContext();
    expect(minted(browser.frameLocator('#result').locator('#myFile'))).toEqual({
      kind: 'frame',
      selector: '#result',
      source: { kind: 'selector', selector: '#myFile' },
    });
  });

  it('is the screen the context minted, with the hatches attached', () => {
    const { browser, screens } = browserWithRecordingContext();
    const frame = browser.frameLocator('#result');
    expect(screens).toHaveLength(1);
    expect(frame).toBe(screens[0]);
    expect(typeof frame.locator).toBe('function');
  });

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
