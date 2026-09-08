/**
 * `@e2edev/cua` public surface: the `cua()` engine factory, the `desktop`
 * fixture types, and a `test` typed with that fixture. `expect` and
 * `credentials` still come from `@e2edev/e2e`.
 */

import { test as base } from '@e2edev/e2e';
import type { Desktop } from './desktop.ts';

export { cua } from './engine.ts';
export type { CuaOptions } from './surface.ts';
export type { Desktop, DesktopWindow } from './desktop.ts';

/**
 * `test` typed with this engine's contributed `desktop` fixture. The same
 * runtime `test` as `@e2edev/e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ desktop: Desktop }>();
