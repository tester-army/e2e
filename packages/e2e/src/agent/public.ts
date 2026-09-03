/**
 * The `e2e/agent` entrypoint (RFC0001): the builders that assemble a step
 * executor on the AI SDK — the chassis and `defineTool`. The socket
 * vocabulary itself — `StepExecutor`, verdicts, `BLOCKABLE_CODES` — lives on
 * the main `e2e` entrypoint, so a hand-rolled executor needs no import from
 * here (and no AI SDK) at all.
 */

export {
  createToolLoopExecutor,
  type ToolLoopExecutorOptions,
  type PreparedTurn,
  type PreparedMessages,
  type ToolLoopHelpers,
} from './tool-loop.ts';
export {
  defineTool,
  isDefinedTool,
  toolAppliesTo,
  type DefinedTool,
  type ToolAnnotations,
} from './tool.ts';
export { AgentError, isAgentError } from './error.ts';
