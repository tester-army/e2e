/**
 * The `e2e/agent` entrypoint: the builders that assemble a step
 * executor on the AI SDK. `createAgent` is the golden path;
 * `createToolLoopExecutor` is the same loop with a caller's own prompt and
 * tool vocabulary. The socket vocabulary itself — `StepExecutor`, verdicts,
 * `BLOCKABLE_CODES` — lives on the main `e2e` entrypoint, so a hand-rolled
 * executor needs no import from here (and no AI SDK) at all.
 */

export { createAgent, type CreateAgentOptions, type DefaultAgent } from './default-agent.ts';
export {
  createToolLoopExecutor,
  type ToolLoopExecutorOptions,
  type PreparedTurn,
  type PreparedMessages,
  type ToolLoopHelpers,
} from './tool-loop.ts';
export {
  defineTool,
  getToolContext,
  isDefinedTool,
  toolAppliesTo,
  type DefinedTool,
  type ToolAnnotations,
} from './tool.ts';
export { AgentError, isAgentError } from './error.ts';
