/**
 * The `desktop` fixture: deterministic window management this engine
 * contributes. Not an agent tool; a test calls these directly to arrange or
 * assert desktop state, and the harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import type { EngineFixtureContext, Locator } from '@e2edev/e2e/engine';
import type { CuaSurface } from './surface.ts';

/** The observed window as the desktop reports it. */
export interface DesktopWindow {
  readonly title: string;
  /** Position and size on the desktop, in points; undefined when the driver reports none. */
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined;
}

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /**
   * A locator from a Cua selector (`'id=SaveButton'`, `'role=AXPopUpButton label="Font"'`),
   * for nodes the closed `screen` query vocabulary cannot name. Same polling
   * and strictness as any locator.
   */
  locator(selector: string): Locator;
  /** Invokes one menu-bar path, outermost first: `['File', 'New']`. */
  menu(path: readonly string[]): Promise<void>;
  /** Sends one key chord to the window: `'Meta+n'`, `'Shift+Tab'`, `'Escape'`. */
  hotkey(chord: string): Promise<void>;
  /** The observed window's title and bounds. */
  window(): Promise<DesktopWindow>;
}

/** Builds the desktop fixture for one attempt. */
export function createDesktopFixture(surface: CuaSurface, context: EngineFixtureContext): Desktop {
  const desktop: Desktop = {
    locator: (selector) => context.locator({ kind: 'selector', selector }),
    async menu(path) {
      await surface.invokeMenu(path, context.signal);
    },
    async hotkey(chord) {
      await surface.hotkey(chord, context.signal);
    },
    async window() {
      return surface.window(context.signal);
    },
  };
  return context.fixture('desktop', desktop, {
    menu: { kind: 'resource', label: (path) => path.join(' > ') },
    hotkey: { kind: 'resource', label: (chord) => chord },
    window: { kind: 'resource' },
  });
}
