/**
 * The `e2e/agent` entrypoint: what a project builds agents from on the AI
 * SDK. The built-in agent needs no builder: an agents entry is one plain
 * object (`agents: { default: { model, system, tools } }`), and `defineTool`
 * makes its project tools. `createToolLoopExecutor` is the built-in agent's
 * loop with a caller's own prompt and tool vocabulary, for a custom brain
 * under `{ executor }`. `createGrammarTools` and `BASE_RULES` are the
 * built-in agent's action tools and their rules, and `createVerdictTool` and
 * `VERDICT_RULES` its `complete_step`, for a loop or an executor that keeps
 * the built-in actions and verdicts. The socket vocabulary itself, `StepExecutor` and its
 * verdicts, lives on the main `e2e` entrypoint, so a hand-rolled executor
 * needs no import from here (and no AI SDK) at all.
 */

export {
  createToolLoopExecutor,
  type ToolLoopExecutorOptions,
  type PreparedTurn,
  type PreparedMessages,
  type ToolLoopHelpers,
} from './tool-loop.ts';
export { defineTool, getToolContext, type DefinedTool, type ToolAnnotations } from './tool.ts';
export { AgentError, isAgentError } from './error.ts';
export {
  createGrammarTools,
  createVerdictTool,
  VERDICT_RULES,
  type GrammarToolOptions,
  type VerdictTool,
} from './primitives.ts';
export { BASE_RULES } from './default-agent.ts';
export { isRuntimeHardStop } from './executor.ts';
export type { ScreenOutput } from './screen-update.ts';
