/**
 * The brand `createAgent` stamps on the executors it builds, kept apart from
 * the agent itself so config resolution can recognize a built-in agent
 * without importing the agent module, which imports the config in turn.
 */

import type { StepExecutor } from './executor.ts';

export const DEFAULT_AGENT_MARKER: unique symbol = Symbol.for('e2e.default-agent.v1');

/**
 * The app vocabulary a built-in agent was created with (`createAgent({ context })`).
 * Undefined for any other executor: a custom `StepExecutor` may carry a
 * `context` member of its own, and whatever it holds is not a prompt.
 */
export function builtInAgentContext(executor: StepExecutor | undefined): string | undefined {
  if (executor === undefined || !(DEFAULT_AGENT_MARKER in executor)) return undefined;
  const { options } = executor as { readonly options?: { readonly context?: unknown } };
  return typeof options?.context === 'string' ? options.context : undefined;
}
