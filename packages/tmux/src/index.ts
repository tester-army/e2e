/**
 * `@e2edev/tmux` public surface: the `tmux()` backend factory, the `terminal`
 * fixture types, and a `test` typed with that fixture. `expect` still comes
 * from `@e2edev/e2e`; the agent-side tool pack lives on the
 * `@e2edev/tmux/tools` subpath so this entry never loads the AI SDK.
 */

import { test as base } from '@e2edev/e2e';
import type { Terminal } from './terminal.ts';

export { tmux } from './backend.ts';
export type { TmuxOptions } from './surface.ts';
export type { Terminal } from './terminal.ts';

/**
 * `test` typed with this backend's contributed `terminal` fixture. The same
 * runtime `test` as `@e2edev/e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ terminal: Terminal }>();
