/**
 * The default step executor (RFC0001, layer 4 golden path): an AI SDK
 * ToolLoopAgent over the harness action grammar.
 *
 * The loop mirrors the shape proven in production: the model works one step
 * with a small tool vocabulary, every mutating tool returns the updated
 * screen, and the only way to finish is the `complete_step` verdict tool.
 * Budget and timeout failures are runtime truth: they stop the loop and
 * synthesize a `blocked` verdict instead of trusting the model to report its
 * own exhaustion.
 */

import {
  stepCountIs,
  tool,
  ToolLoopAgent,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { asSdkLanguageModel, type SdkLanguageModel } from '../config/agent.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  BLOCKABLE_CODES,
  RUNTIME_CODES,
  type StepExecutor,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import type { DefinedTool } from './tool.ts';
import { isDefinedTool } from './tool.ts';

/** Codes the model may pick when concluding; runtime codes are runtime-assigned. */
const MODEL_ERROR_CODES = [
  'ACTION_FAILED',
  'ASSERTION_FAILED',
  'AUTHENTICATION_FAILED',
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'APP_UNREACHABLE',
  'APP_NOT_OPEN',
  'POLICY_DENIED',
] as const;

/** The model-pickable codes a blocked verdict accepts; derived, never restated. */
const MODEL_BLOCKABLE_CODES = MODEL_ERROR_CODES.filter((code) => BLOCKABLE_CODES.has(code));

const BASE_RULES = `You are an autonomous end-to-end testing agent executing exactly one test step against a real application.

Rules:
- Work only toward the given step; do not start the next step or explore beyond it.
- Use the tools to inspect and act. Node ids like "n42" are valid only for the newest observation; after any action, use ids from the latest "Updated screen" snapshot.
- Never invent node ids. If the target is not on screen, scroll or navigate to find it, or conclude.
- Verify outcomes on screen before concluding; never guess success.
- When the step's goal is achieved, or you are certain it cannot be, call complete_step exactly once.
- Verdicts: "passed" means the application behaved as the step required. "failed" means it did not. "blocked" means credentials, the environment, or test setup prevented a product verdict — blocked says nothing about the product and requires an errorCode.`;

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
  return {
    name: 'e2e-default-agent',
    version: '1',
    async runStep(context: StepExecutorContext): Promise<StepVerdict> {
      const configured = context.model === undefined ? undefined : asSdkLanguageModel(context.model);
      const model: LanguageModel | undefined = options.model ?? configured;
      if (model === undefined) {
        throw new AgentError(
          'MODEL_UNAVAILABLE',
          'the default agent requires a model: set agent.model, E2E_MODEL, or createAgent({ model })',
        );
      }
      const state: LoopState = { verdict: undefined, hardStop: undefined };
      const tools: ToolSet = {
        ...wrapUserTools(context, state, userTools),
        ...buildDefaultTools(context, state),
      };
      // Capped, never raised: the harness budget is the ceiling for any turns
      // setting, so the loop cannot spend past what the step was given.
      const maxTurns = Math.min(
        options.maxTurns ?? context.budgets.maxModelCalls,
        context.budgets.maxModelCalls,
      );
      const loop = new ToolLoopAgent({
        model,
        instructions: buildInstructions(context, options.system),
        tools,
        toolChoice: 'required',
        stopWhen: [
          () => state.verdict !== undefined || state.hardStop !== undefined,
          stepCountIs(maxTurns),
        ],
        prepareStep: ({ messages, stepNumber }) => {
          const prepared = withWindDownNotice(compactSnapshotHistory(messages), maxTurns - stepNumber);
          return {
            ...(prepared === messages ? {} : { messages: prepared }),
            ...forcedConclusion(maxTurns - stepNumber),
          };
        },
      });
      const identity = model as { provider?: string; modelId?: string };
      const observation = await context.observe();
      let turnStartedMs = Date.now();
      try {
        await loop.generate({
          prompt: buildPrompt(context, observation),
          abortSignal: context.signal,
          onStepStart: () => {
            turnStartedMs = Date.now();
          },
          onStepEnd: ({ usage }) => {
            context.budgets.recordModelCall({
              ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
              ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
              durationMs: Date.now() - turnStartedMs,
              ...(typeof identity.provider === 'string' ? { provider: identity.provider } : {}),
              ...(typeof identity.modelId === 'string' ? { modelId: identity.modelId } : {}),
            });
          },
        });
      } catch (cause) {
        if (context.signal.aborted) {
          throw new AgentError('CANCELLED', 'agent.act was cancelled', { cause });
        }
        if (state.hardStop !== undefined) throw state.hardStop;
        if (isAgentError(cause)) throw cause;
        throw new AgentError(
          'MODEL_PROVIDER_FAILED',
          `the model provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      if (state.verdict !== undefined) return state.verdict;
      if (state.hardStop !== undefined) {
        if (state.hardStop.code === 'CANCELLED') throw state.hardStop;
        return {
          status: 'blocked',
          summary: state.hardStop.message,
          errorCode: state.hardStop.code,
        };
      }
      return {
        status: 'failed',
        summary: `the agent used ${maxTurns} turn(s) without calling complete_step`,
        errorCode: 'STEP_NO_CONCLUSION',
      };
    },
  };
}

interface LoopState {
  verdict: StepVerdict | undefined;
  hardStop: AgentError | undefined;
}

/** The default toolset: thin AI SDK tools over the harness action grammar. */
function buildDefaultTools(context: StepExecutorContext, state: LoopState): ToolSet {
  /**
   * Runs one tool body under loop policy: after a hard stop nothing else
   * executes, a fatal error ends the loop through `state`, and every other
   * failure goes back to the model as text it can react to.
   */
  const guard = async (body: () => Promise<string>): Promise<string> => {
    if (state.hardStop !== undefined || state.verdict !== undefined) {
      return 'The step is already concluding; no further actions run.';
    }
    try {
      return await body();
    } catch (cause) {
      if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) {
        state.hardStop = cause;
        return `HARD STOP (${cause.code}): ${cause.message}`;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return `Action failed: ${message}`;
    }
  };

  /** Re-observes after a mutating action so the model always sees the result. */
  const acted = async (description: string): Promise<string> => {
    const observation = await context.observe();
    return `${description}\n\nUpdated screen (revision ${observation.revision}):\n${observation.text}`;
  };

  const target = z
    .string()
    .min(1)
    .describe('Node id from the newest observation, e.g. "n42"');

  return {
    tap: tool({
      description: 'Tap or click one node.',
      inputSchema: z.object({ target }),
      execute: ({ target: id }) =>
        guard(async () => {
          await context.actions.tap({ id });
          return acted(`Tapped #${id}.`);
        }),
    }),
    type: tool({
      description: 'Type a plain-text value into one input node. Replaces the current value.',
      inputSchema: z.object({ target, value: z.string() }),
      execute: ({ target: id, value }) =>
        guard(async () => {
          await context.actions.type({ id }, value);
          return acted(`Typed into #${id}.`);
        }),
    }),
    press: tool({
      description: 'Send one key (e.g. "Enter", "Escape", "Tab") to one node.',
      inputSchema: z.object({ target, key: z.string().min(1).max(64) }),
      execute: ({ target: id, key }) =>
        guard(async () => {
          await context.actions.press({ id }, key);
          return acted(`Pressed ${key} on #${id}.`);
        }),
    }),
    select: tool({
      description: 'Pick one option from a select-like control by its visible label.',
      inputSchema: z.object({ target, value: z.string().min(1) }),
      execute: ({ target: id, value }) =>
        guard(async () => {
          await context.actions.select({ id }, value);
          return acted(`Selected "${value}" in #${id}.`);
        }),
    }),
    scroll: tool({
      description: 'Scroll the viewport, or one scrollable node when target is given.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']),
        target: target.optional(),
      }),
      execute: ({ direction, target: id }) =>
        guard(async () => {
          await context.actions.scroll(direction, id === undefined ? undefined : { id });
          return acted(`Scrolled ${direction}.`);
        }),
    }),
    navigate: tool({
      description: 'Navigate to a URL or app-relative path within the allowed origins.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) =>
        guard(async () => {
          await context.actions.navigate(url);
          return acted(`Navigated to ${url}.`);
        }),
    }),
    observe: tool({
      description: 'Capture a fresh observation of the current screen without acting.',
      inputSchema: z.object({}),
      execute: () =>
        guard(async () => {
          const observation = await context.observe();
          return `Current screen (revision ${observation.revision}):\n${observation.text}`;
        }),
    }),
    complete_step: tool({
      description:
        'Conclude the step with the final verdict. passed = the application behaved as required and you verified it on screen. failed = the application did not behave as required. blocked = credentials, environment, or test setup prevented a product verdict; blocked requires errorCode.',
      inputSchema: z.object({
        status: z.enum(['passed', 'failed', 'blocked']),
        summary: z
          .string()
          .min(1)
          .max(500)
          .describe('What you did and what you saw, in plain language'),
        errorCode: z.enum(MODEL_ERROR_CODES).optional(),
      }),
      execute: async (input): Promise<string> => {
        if (state.verdict !== undefined) return 'The step already concluded.';
        if (
          input.status === 'blocked' &&
          (input.errorCode === undefined ||
            !MODEL_BLOCKABLE_CODES.includes(input.errorCode as (typeof MODEL_BLOCKABLE_CODES)[number]))
        ) {
          return (
            'Rejected: a blocked verdict requires errorCode naming what blocked you ' +
            `(one of ${MODEL_BLOCKABLE_CODES.join(', ')}). ` +
            'If the application itself misbehaved, use status "failed" instead.'
          );
        }
        state.verdict = {
          status: input.status,
          summary: input.summary,
          // A passed verdict never carries a code; a redundant one from the
          // model is dropped rather than failing the step.
          ...(input.errorCode === undefined || input.status === 'passed'
            ? {}
            : { errorCode: input.errorCode }),
        };
        return 'Step concluded.';
      },
    }),
  };
}

/** How many trailing screen snapshots stay verbatim in the transcript. */
const SNAPSHOT_PRESERVE_COUNT = 2;

/** Turns remaining when the loop warns the model to wrap up. */
const WIND_DOWN_TURNS = 5;

const SNAPSHOT_PATTERN = /(?:Updated|Current) screen \(revision /;

/**
 * The two final turns take the verdict and nothing else: a model that wanders
 * never concludes on its own, and STEP_NO_CONCLUSION after a full budget is
 * strictly worse than a forced verdict. Two turns, not one, so a rejected
 * verdict (blocked without a code) can be repaired.
 */
function forcedConclusion(turnsLeft: number): { activeTools: string[]; toolChoice: { type: 'tool'; toolName: string } } | Record<string, never> {
  if (turnsLeft > 2) return {};
  return {
    activeTools: ['complete_step'],
    toolChoice: { type: 'tool', toolName: 'complete_step' },
  };
}

/** Warns the model once, a few turns before the conclusion is forced. */
function withWindDownNotice(messages: ModelMessage[], turnsLeft: number): ModelMessage[] {
  if (turnsLeft !== WIND_DOWN_TURNS) return messages;
  return [
    ...messages,
    {
      role: 'user',
      content:
        `[SYSTEM NOTICE] Only ${turnsLeft} turns remain for this step. ` +
        'Finish the remaining work now, or call complete_step with your ' +
        'best verdict: failed if the application misbehaved, blocked ' +
        '(with errorCode) if something outside the application stopped you.',
    },
  ];
}

/**
 * Compacts stale screen snapshots out of the tool-result history.
 *
 * Only the newest observations describe the page the model is acting on;
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

function buildInstructions(context: StepExecutorContext, system: string | undefined): string {
  const parts = [BASE_RULES];
  if (context.agentContext !== undefined && context.agentContext.trim() !== '') {
    parts.push(`Project context:\n${context.agentContext}`);
  }
  if (system !== undefined && system.trim() !== '') parts.push(system);
  return parts.join('\n\n');
}

function buildPrompt(
  context: StepExecutorContext,
  observation: { revision: string; text: string },
): string {
  const parts = [`Execute this test step: ${context.step.instruction}`];
  if (context.step.params !== undefined) {
    parts.push(`Step parameters:\n${JSON.stringify(context.step.params, null, 2)}`);
  }
  if (context.ledger !== '') {
    parts.push(`Previously completed steps:\n${context.ledger}`);
  }
  parts.push(`Current screen (revision ${observation.revision}):\n${observation.text}`);
  return parts.join('\n\n');
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
  state: LoopState,
  tools: Readonly<Record<string, DefinedTool>>,
): ToolSet {
  const wrapped: Record<string, ToolSet[string]> = {};
  for (const [name, defined] of Object.entries(tools)) {
    const execute = defined.tool.execute?.bind(defined.tool);
    if (execute === undefined) {
      wrapped[name] = defined.tool;
      continue;
    }
    wrapped[name] = {
      ...defined.tool,
      execute: async (input: never, executionOptions: never) => {
        if (state.hardStop !== undefined || state.verdict !== undefined) {
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
            state.hardStop = cause;
            return `HARD STOP (${cause.code}): ${cause.message}`;
          }
          throw cause;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}
