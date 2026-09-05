/**
 * The `@e2edev/e2e/agent` entrypoint (RFC0001): the builders that assemble a step
 * executor on the AI SDK. `createAgent` is the golden path. The socket
 * vocabulary itself — `StepExecutor`, verdicts, `BLOCKABLE_CODES` — lives on
 * the main `e2e` entrypoint, so a hand-rolled executor needs no import from
 * here (and no AI SDK) at all.
 */

export {
  compactSnapshotHistory,
  createAgent,
  formatReplayedPrefix,
  type CreateAgentOptions,
} from './default-agent.ts';
export {
  conversationMemory,
  createGrammarTools,
  createVerdictTool,
  trackModelCalls,
  VERDICT_RULES,
  type ConversationMemory,
  type GrammarToolOptions,
  type ModelCallTracker,
  type VerdictTool,
} from './primitives.ts';

export {
  createToolLoopExecutor,
  type ToolLoopExecutorOptions,
  type PreparedTurn,
  type PreparedMessages,
  type ToolLoopHelpers,
  type WindDownPolicy,
} from './tool-loop.ts';
export { serializeLedger, type LedgerContext } from './ledger.ts';
export type { LoopGuardThresholds } from './loop-guards.ts';

export {
  defineTool,
  getToolContext,
  isDefinedTool,
  toolAppliesTo,
  type DefinedTool,
  type ToolAnnotations,
} from './tool.ts';
export { AgentError, isAgentError } from './error.ts';
