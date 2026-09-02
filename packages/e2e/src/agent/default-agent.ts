/**
 * The default step executor (RFC0001, layer 4 golden path): the tool-loop
 * chassis plus the grammar toolset. Every mutating tool returns the
 * updated screen; verdicts, budgets, hard stops, loop guards, wind-down, and
 * the transcript come from the chassis (`tool-loop.ts`) unchanged.
 */

import type { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';
import type { SdkLanguageModel } from '../config/agent.ts';
import { aiSdk } from './ai-sdk.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  RUNTIME_CODES,
  type ReplayedPrefix,
  type StepExecutor,
  type StepExecutorContext,
} from './executor.ts';
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
    compactMessages: compactSnapshotHistory,
    tools: (context, helpers) => ({
      ...wrapUserTools(context, helpers, userTools),
      ...buildGrammarTools(context, helpers),
    }),
    buildPrompt: async (context) => {
      const observation = await context.observe();
      const parts = [
        context.step.kind === 'assert'
          ? `Judge whether this assertion holds; do not change application state: ${context.step.instruction}`
          : `Execute this test step: ${context.step.instruction}`,
      ];
      if (context.step.params !== undefined) {
        parts.push(`Step parameters:\n${JSON.stringify(context.step.params, null, 2)}`);
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
function formatReplayedPrefix(prefix: ReplayedPrefix): string {
  const lines = prefix.replayedActions.map((summary, index) => `${index + 1}. ${summary}`);
  return [
    'Cached replay already performed these recorded actions for this step:',
    ...lines,
    `Replay stopped (${prefix.stopReason}) after ${prefix.replayedActions.length} of ${prefix.totalActions} recorded actions.`,
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
 * The default toolset: thin AI SDK tools over the harness action grammar,
 * limited to the verbs the target's backend declared. A verb the surface cannot
 * honor is not offered at all, so the model never learns vocabulary it can only
 * be rejected on.
 */
function buildGrammarTools(context: StepExecutorContext, helpers: ToolLoopHelpers): ToolSet {
  const { guard } = helpers;
  const { verbs } = context.target;

  /** Re-observes after a mutating action so the model always sees the result. */
  const acted = async (description: string): Promise<string> => {
    const observation = await context.observe();
    return `${description}\n\nUpdated screen (revision ${observation.revision}):\n${observation.text}`;
  };

  const target = z
    .string()
    .min(1)
    .describe('Node id from the newest observation, e.g. "n42"');

  // The chassis loads the AI SDK before building tools, so reading the
  // cached instance here cannot race the optional-peer loader.
  const { tool } = aiSdk();

  const tools: ToolSet = {
    observe: tool({
      description: 'Capture a fresh observation of the current screen without acting.',
      inputSchema: z.object({}),
      execute: () =>
        guard(async () => {
          const observation = await context.observe();
          return `Current screen (revision ${observation.revision}):\n${observation.text}`;
        }),
    }),
  };
  if (verbs.has('tap')) {
    tools['tap'] = tool({
      description: 'Tap or click one node.',
      inputSchema: z.object({ target }),
      execute: ({ target: id }) =>
        guard(async () => {
          await context.actions.tap({ id });
          return acted(`Tapped #${id}.`);
        }),
    });
  }
  if (verbs.has('type')) {
    tools['type'] = tool({
      description: 'Type a plain-text value into one input node. Replaces the current value.',
      inputSchema: z.object({ target, value: z.string() }),
      execute: ({ target: id, value }) =>
        guard(async () => {
          await context.actions.type({ id }, value);
          return acted(`Typed into #${id}.`);
        }),
    });
  }
  if (verbs.has('press')) {
    tools['press'] = tool({
      description: 'Send one key (e.g. "Enter", "Escape", "Tab") to one node.',
      inputSchema: z.object({ target, key: z.string().min(1).max(64) }),
      execute: ({ target: id, key }) =>
        guard(async () => {
          await context.actions.press({ id }, key);
          return acted(`Pressed ${key} on #${id}.`);
        }),
    });
  }
  if (verbs.has('select')) {
    tools['select'] = tool({
      description: 'Pick one option from a select-like control by its visible label.',
      inputSchema: z.object({ target, value: z.string().min(1) }),
      execute: ({ target: id, value }) =>
        guard(async () => {
          await context.actions.select({ id }, value);
          return acted(`Selected "${value}" in #${id}.`);
        }),
    });
  }
  if (verbs.has('scroll')) {
    const direction = z.enum(['up', 'down', 'left', 'right']);
    // Node-targeted scrolling rides `perform`; without it only the viewport scrolls.
    tools['scroll'] = verbs.has('tap')
      ? tool({
          description: 'Scroll the viewport, or one scrollable node when target is given.',
          inputSchema: z.object({ direction, target: target.optional() }),
          execute: ({ direction: way, target: id }) =>
            guard(async () => {
              await context.actions.scroll(way, id === undefined ? undefined : { id });
              return acted(`Scrolled ${way}.`);
            }),
        })
      : tool({
          description: 'Scroll the viewport.',
          inputSchema: z.object({ direction }),
          execute: ({ direction: way }) =>
            guard(async () => {
              await context.actions.scroll(way);
              return acted(`Scrolled ${way}.`);
            }),
        });
  }
  if (verbs.has('navigate')) {
    tools['navigate'] = tool({
      description: 'Navigate to a URL or app-relative path within the allowed origins.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) =>
        guard(async () => {
          await context.actions.navigate(url);
          return acted(`Navigated to ${url}.`);
        }),
    });
  }
  // Offered only when the step declared secrets and the surface can fill: an
  // empty vocabulary is better than a tool the model can only be rejected on.
  if (verbs.has('typeSecret') && context.step.secrets.length > 0) {
    tools['type_secret'] = tool({
      description:
        'Fill one declared secret credential into a secure input field; the plaintext never passes through you. Available: ' +
        context.step.secrets.map((secret) => `"${secret.name}" (${secret.purpose})`).join(', ') +
        '.',
      inputSchema: z.object({ target, name: z.string().min(1) }),
      execute: ({ target: id, name }) =>
        guard(async () => {
          await context.actions.typeSecret({ id }, name);
          return acted(`Filled secret "${name}" into #${id}.`);
        }),
    });
  }
  return tools;
}

/**
 * Compacts stale screen snapshots out of the tool-result history.
 *
 * Only the newest observations describe the screen the model is acting on;
 * every older tree is dead weight that grows the prompt linearly with turn
 * count. Stale snapshot results keep their first line (what the action did)
 * and lose the tree. Returns the input array unchanged when there is nothing
 * to compact, so the caller can skip the messages override entirely.
 */
function compactSnapshotHistory(messages: ModelMessage[]): ModelMessage[] {
  const total = messages.reduce(
    (count, message) => count + snapshotParts(message).filter((text) => text !== undefined).length,
    0,
  );
  let stale = total - SNAPSHOT_PRESERVE_COUNT;
  if (stale <= 0) return messages;
  return messages.map((message) => {
    if (stale <= 0 || message.role !== 'tool') return message;
    const texts = snapshotParts(message);
    if (!texts.some((text) => text !== undefined)) return message;
    const content = message.content.map((part, index) => {
      const text = texts[index];
      if (text === undefined || stale <= 0) return part;
      stale -= 1;
      const firstLine = text.split('\n', 1)[0] ?? '';
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: `${firstLine}\n[stale screen snapshot elided; act on the newest observation]`,
        },
      };
    });
    return { ...message, content };
  });
}

/** Per-part snapshot text of one message; undefined for non-snapshot parts. */
function snapshotParts(message: ModelMessage): (string | undefined)[] {
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
  }
  return tools;
}

/**
 * Wraps project tools so they run the same accounting pipeline as the
 * grammar: every call is recorded, a mutating tool consumes an action-budget
 * slot, and a budget hard stop ends the loop instead of leaking as a tool
 * error the model talks past.
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
    // defineTool rejected any tool without execute at definition time.
    const execute = defined.tool.execute?.bind(defined.tool);
    if (execute === undefined) throw new Error(`tool "${name}" has no execute; defineTool must reject it`);
    wrapped[name] = {
      ...defined.tool,
      execute: async (input: never, executionOptions: never) => {
        if (helpers.concluding()) {
          return 'The step is already concluding; no further actions run.';
        }
        const startedMs = Date.now();
        try {
          const result = await execute(input, executionOptions);
          context.budgets.recordToolCall({
            name,
            mutates: defined.annotations.mutates,
            durationMs: Date.now() - startedMs,
          });
          return result;
        } catch (cause) {
          if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) {
            helpers.reportHardStop(cause);
            return `HARD STOP (${cause.code}): ${cause.message}`;
          }
          throw cause;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}
