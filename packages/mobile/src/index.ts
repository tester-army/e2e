/**
 * `@e2e-dev/mobile` public surface: the `mobile()` engine factory, the
 * `device` fixture types, and `test`, `describe`, and the hooks typed with
 * that fixture. `expect`, `credentials`, and `secrets` still come from
 * `e2e`; the agent-side tool pack lives on the `@e2e-dev/mobile/tools`
 * subpath so this entry never loads the AI SDK.
 */

import { test as base } from 'e2e';
import type { MobileFixtures } from './fixtures.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `device` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<MobileFixtures>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `device` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
