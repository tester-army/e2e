/**
 * `@e2edev/jev`: a step executor for e2e whose brain is TypeSafe AI's Jev
 * evaluation model. One evaluate call per turn decides done / verb / node /
 * value in parallel; an optional generative fallback writes the values a step
 * leaves open.
 */

export { jevAgent } from './agent.ts';
export type { JevAgentOptions } from './agent.ts';
