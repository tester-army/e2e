/** Public sdk-0.1 entrypoint. */

import type { AgentErrorCode, E2EConfig } from './types.ts';

export { test } from './collect/registry.ts';
export { expect } from './expect/index.ts';
export { credentials } from './credentials.ts';

/** Runner-classified agent failure (spec api/e2e.d.ts). */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly explanation: string;
  readonly screenshot?: string;

  constructor(
    code: AgentErrorCode,
    explanation: string,
    options: { screenshot?: string; cause?: unknown } = {},
  ) {
    super(explanation, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentError';
    this.code = code;
    this.explanation = explanation;
    if (options.screenshot !== undefined) this.screenshot = options.screenshot;
  }
}

/** Type-checks and returns an e2e configuration object. */
export function defineConfig(config: E2EConfig): E2EConfig {
  return config;
}

export type * from './types.ts';
