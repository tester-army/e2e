/**
 * The built-in agent's identity, kept apart from the agent itself so the
 * fixtures can name it without loading the agent's loop.
 */

/**
 * The name and version every built-in agent reports. Cache provenance and
 * the model policy version record them, so a committed recording stays
 * valid whatever options an agents entry sets.
 */
export const BUILT_IN_AGENT = { name: 'e2e-default-agent', version: '2' } as const;
