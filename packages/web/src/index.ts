/**
 * `@e2e-dev/web` public surface: the `web()` engine factory, the `browser`
 * fixture types, and `test`, `describe`, and the hooks typed with that
 * fixture, so a test file registers from one import. `expect`,
 * `credentials`, and `secrets` come from `e2e` itself.
 */

import { test as base } from 'e2e';
import type { WebFixtures } from './fixtures.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `browser` fixture and its
 * `app`. The same runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<WebFixtures>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `browser` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
