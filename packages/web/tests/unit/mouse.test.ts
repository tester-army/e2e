/** Invalid coordinates must fail before pointer input reaches the browser. */
import { expect, it, vi } from 'vitest';
import type { EngineFixtureContext } from 'e2e/engine';
import type { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture } from '../../src/browser.ts';

it.each([[NaN, 80], [120, Infinity], [-Infinity, 80], ['120', 80], [120, undefined]])(
  'rejects invalid double-click coordinates (%s, %s) before dispatch', (x, y) => {
    const guard = vi.fn();
    const browser = createBrowserFixture({ guard } as unknown as PlaywrightSurface, {
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    expect(() => browser.mouse.dblclick(x as number, y as number)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(guard).not.toHaveBeenCalled();
  },
);
