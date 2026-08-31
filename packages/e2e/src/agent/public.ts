/**
 * The `e2e/agent` entrypoint (RFC0001): everything a brain builder needs to
 * implement or assemble a step executor. `createAgent` is the AI SDK golden
 * path; the `StepExecutor` interface is the raw socket a hand-rolled executor
 * implements with no AI SDK at all.
 */

export { createAgent, type CreateAgentOptions } from './default-agent.ts';
export { defineTool, isDefinedTool, type DefinedTool, type ToolAnnotations } from './tool.ts';
export {
  BLOCKABLE_CODES,
  isStepExecutor,
  type ExecutorActions,
  type ExecutorBudgets,
  type ExecutorObservation,
  type ExecutorStep,
  type ExecutorTarget,
  type StepExecutor,
  type StepExecutorContext,
  type StepVerdict,
  type StepVerdictStatus,
} from './executor.ts';
export { AgentError, isAgentError } from './error.ts';
