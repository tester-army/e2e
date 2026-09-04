/**
 * The default step executor (RFC0001, layer 4 golden path): the tool-loop
 * chassis plus the grammar toolset, kept deliberately small. Every mutating
 * tool returns the updated screen; verdicts, budgets, hard stops, loop
 * guards, wind-down, and the transcript come from the chassis
 * (`tool-loop.ts`) unchanged.
 *
 * Like the AI SDK's own agent, it is a thin opinion over parts you can also
 * use directly: `createToolLoopExecutor` is the same loop with your own
 * prompt and vocabulary, and `primitives.ts` — grammar tools, the verdict
 * tool, model-call accounting, conversation memory, plus the compaction and
 * hand-off notice exported here — composes with either, or with a raw
 * `ToolLoopAgent` / `generateText`, for anything else.
 */

import type { ModelMessage, ToolSet } from 'ai';
import type { SdkLanguageModel } from '../config/agent.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  RUNTIME_CODES,
  type ReplayedPrefix,
  type StepExecutor,
  type StepExecutorContext,
} from './executor.ts';
import { createGrammarTools } from './primitives.ts';
import { createToolLoopExecutor, type ToolLoopHelpers } from './tool-loop.ts';
import type { DefinedTool } from './tool.ts';
import { isDefinedTool, toolAppliesTo } from './tool.ts';

const BASE_RULES = `You are an autonomous end-to-end testing agent executing exactly one test step against a real application.

Rules:
- Work only toward the given step; do not start the next step or explore beyond it.
- Use the tools to inspect and act. Node ids like "n42" are valid only for the newest observation; after any action, use ids from the latest "Updated screen" snapshot.
- Issue at most ONE mutating tool call per turn: every mutation refreshes the screen and invalidates all earlier node ids, so a second action batched in the same turn targets a stale screen and fails.
- Never invent node ids. If the target is not on screen, bring it on screen with the tools you have (scroll, navigate) or conclude.`;

/** How many trailing screen snapshots stay verbatim in the transcript. */
const SNAPSHOT_PRESERVE_COUNT = 2;

const SNAPSHOT_PATTERN = /(?:Updated|Current) screen \(revision /;

export interface CreateAgentOptions {
  /** AI SDK language model; defaults to the config-resolved `agent.model`. */
  readonly model?: SdkLanguageModel;
  /** Extra system guidance appended to the base execution rules. */
  readonly system?: string;
  /** Project tools from `defineTool`, merged with the default toolset. */
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  /** Upper bound on model turns per step; defaults to the model-call budget. */
  readonly maxTurns?: number;
  /** AI SDK provider options passed to every model call (e.g. a thinking level). */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Builds the default AI SDK step executor. */
export function createAgent(options: CreateAgentOptions = {}): StepExecutor {
  const userTools = validateUserTools(options.tools);
  const system = [BASE_RULES, options.system]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n\n');
  return createToolLoopExecutor({
    name: 'e2e-default-agent',
    version: '2',
    ...(options.model === undefined ? {} : { model: options.model }),
    system,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    prepareMessages: compactSnapshotHistory,
    tools: (context, helpers) => ({
      ...wrapUserTools(context, helpers, userTools),
      ...createGrammarTools(context, { guard: helpers.guard }),
    }),
    buildPrompt: async (context) => {
      const observation = await context.observe();
      const parts = [
        context.step.kind === 'assert'
          ? `Judge whether this assertion holds; do not change application state: ${context.step.instruction}`
          : `Execute this test step: ${context.step.instruction}`,
      ];
      if (context.step.params !== undefined) {
        parts.push(`Step parameters:\n${JSON.stringify(context.step.params)}`);
      }
      if (context.replayedPrefix !== undefined) {
        parts.push(formatReplayedPrefix(context.replayedPrefix));
      }
      if (context.ledger !== '') {
        parts.push(`Previously completed steps:\n${context.ledger}`);
      }
      parts.push(`Current screen (revision ${observation.revision}):\n${observation.text}`);
      return parts.join('\n\n');
    },
  });
}

/**
 * The mid-step hand-off notice (RFC0001 layer 4): prose summaries and a reason
 * token, replacing any ordinary prior-run hint. The agent continues from live
 * state; redoing a replayed action would double-commit a mutation.
 */
export function formatReplayedPrefix(prefix: ReplayedPrefix): string {
  const lines = prefix.replayedActions.map((summary, index) => `${index + 1}. ${summary}`);
  return [
    'Cached replay already performed these recorded actions for this step:',
    ...lines,
    `Replay stopped (${prefix.stopReason}) after ${prefix.replayedActions.length} of ${prefix.totalActions} recorded actions.`,
    ...(prefix.stopReason === 'end-mismatch'
      ? [
          'Every recorded action ran, but the screen does not show the recorded end state. ' +
            'Check whether the step actually took effect before doing anything — the recorded flow may have silently failed to commit.',
        ]
      : []),
    ...(prefix.uncertainAction === undefined
      ? []
      : [
          `WARNING: the next action (${prefix.uncertainAction}) failed with an UNKNOWN commit state — ` +
            'its input may have reached the app. Verify the current state before doing anything like it again.',
        ]),
    'Continue the step from the CURRENT screen state shown below — do NOT redo the actions above.',
  ].join('\n');
}

/**
 * Compacts stale screen snapshots out of the history: the initial prompt's
 * `Current screen` and every tool result's `Updated screen`.
 *
 * Only the newest observations describe the screen the model is acting on;
 * every older tree is dead weight that grows the prompt linearly with turn
 * count - and the very first tree, in the user prompt, is the oldest of all.
 * A stale snapshot keeps what preceded the tree (the instruction, or what
 * the action did) and loses the tree. Returns the input array unchanged when
 * there is nothing to compact, so the caller can skip the messages override.
 * Exported as the default `prepareMessages` a custom one can compose with.
 */
export function compactSnapshotHistory(messages: ModelMessage[]): ModelMessage[] {

  const total = messages.reduce(
    (count, message) => count + snapshotParts(message).filter((text) => text !== undefined).length,
    0,
  );
  let stale = total - SNAPSHOT_PRESERVE_COUNT;
  if (stale <= 0) return messages;
  return messages.map((message) => {
    if (stale <= 0) return message;
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (!SNAPSHOT_PATTERN.test(message.content)) return message;
        stale -= 1;
        return { ...message, content: elideSnapshot(message.content) };
      }
      const content = message.content.map((part) => {
        if (stale <= 0 || part.type !== 'text' || !SNAPSHOT_PATTERN.test(part.text)) return part;
        stale -= 1;
        return { ...part, text: elideSnapshot(part.text) };
      });
      return { ...message, content };
    }
    if (message.role !== 'tool') return message;
    const texts = snapshotParts(message);
    if (!texts.some((text) => text !== undefined)) return message;
    const content = message.content.map((part, index) => {
      const text = texts[index];
      if (text === undefined || stale <= 0) return part;
      stale -= 1;
      return { ...part, output: { type: 'text' as const, value: elideSnapshot(text) } };
    });
    return { ...message, content };
  });
}

/** Everything before the snapshot marker, then the elision notice in place of the tree. */
function elideSnapshot(text: string): string {
  const at = text.search(SNAPSHOT_PATTERN);
  const head = at <= 0 ? (text.split('\n', 1)[0] ?? '') : text.slice(0, at).trimEnd();
  return `${head}\n[stale screen snapshot elided; act on the newest observation]`;
}

/** Per-part snapshot text of one message; undefined for non-snapshot parts. */
function snapshotParts(message: ModelMessage): (string | undefined)[] {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return [SNAPSHOT_PATTERN.test(message.content) ? message.content : undefined];
    }
    return message.content.map((part) =>
      part.type === 'text' && SNAPSHOT_PATTERN.test(part.text) ? part.text : undefined,
    );
  }
  if (message.role !== 'tool') return [];
  return message.content.map((part) => {
    if (part.type !== 'tool-result') return undefined;
    const output = part.output;
    if (output.type !== 'text' || typeof output.value !== 'string') return undefined;
    return SNAPSHOT_PATTERN.test(output.value) ? output.value : undefined;
  });
}

/** Validates `defineTool` values and reserved names once, at construction. */
function validateUserTools(
  tools: Readonly<Record<string, DefinedTool>> | undefined,
): Readonly<Record<string, DefinedTool>> {
  if (tools === undefined) return {};
  for (const [name, defined] of Object.entries(tools)) {
    if (!isDefinedTool(defined)) {
      throw new AgentError(
        'POLICY_DENIED',
        `tool "${name}" was not created with defineTool; undeclared semantics are not trusted`,
      );
    }
    if (name === 'complete_step') {
      throw new AgentError('POLICY_DENIED', 'the complete_step tool name is reserved');
    }
    if (defined.tool.execute === undefined) {
      throw new AgentError('POLICY_DENIED', `tool "${name}" has no execute function`);
    }
  }
  return tools;
}

/**
 * Wraps project tools so they run the same accounting pipeline as the
 * grammar: every call is recorded, a mutating tool consumes an action-budget
 * slot - refused before it runs once the ceiling is reached, consumed whether
 * it succeeds or fails, exactly like a grammar action - and a runtime hard
 * stop ends the loop. Any other failure goes back to the model as text it can
 * react to, never as a provider failure of the step.
 */
function wrapUserTools(
  context: StepExecutorContext,
  helpers: ToolLoopHelpers,
  tools: Readonly<Record<string, DefinedTool>>,
): ToolSet {
  const wrapped: Record<string, ToolSet[string]> = {};
  for (const [name, defined] of Object.entries(tools)) {
    // A tool scoped to other platforms is not offered, so the model never
    // learns a verb the surface cannot honor.
    if (!toolAppliesTo(defined, context.target.platform)) continue;
    // validateUserTools rejected any tool without execute at construction.
    const execute = defined.tool.execute!.bind(defined.tool);
    const mutates = defined.annotations.mutates;
    wrapped[name] = {
      ...defined.tool,
      execute: async (input: never, executionOptions: never) => {
        if (helpers.concluding()) {
          return 'The step is already concluding; no further actions run.';
        }
        if (mutates && context.budgets.actionsUsed() >= context.budgets.maxActions) {
          const stop = new AgentError(
            'STEP_BUDGET_EXHAUSTED',
            `the step exhausted its action budget of ${context.budgets.maxActions}`,
          );
          helpers.reportHardStop(stop);
          return `HARD STOP (${stop.code}): ${stop.message}`;
        }
        const startedMs = Date.now();
        let attempted = false;
        try {
          attempted = true;
          return await execute(input, executionOptions);
        } catch (cause) {
          if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) {
            helpers.reportHardStop(cause);
            return `HARD STOP (${cause.code}): ${cause.message}`;
          }
          return `Tool "${name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        } finally {
          if (attempted) {
            try {
              context.budgets.recordToolCall({ name, mutates, durationMs: Date.now() - startedMs });
            } catch (cause) {
              if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) helpers.reportHardStop(cause);
            }
          }
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}
