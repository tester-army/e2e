/** Public sdk-0.1 entrypoint. */

import type { E2EConfig } from './types.ts';

export { test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials } from './credentials.ts';
export { AgentError } from './agent/error.ts';

/** Type-checks and returns an e2e configuration object. */
export function defineConfig(config: E2EConfig): E2EConfig {
  return config;
}

export type * from './types.ts';
