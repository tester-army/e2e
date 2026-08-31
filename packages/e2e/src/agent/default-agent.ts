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

import { stepCountIs, tool, ToolLoopAgent, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SdkLanguageModel } from '../config/agent.ts';
import { AgentError, isAgentError } from './error.ts';
import type { StepExecutor, StepExecutorContext, StepVerdict } from './executor.ts';
import type { DefinedTool } from './tool.ts';
import { isDefinedTool } from './tool.ts';

/** Codes that end the loop immediately; the model never talks past them. */
const HARD_STOP_CODES = new Set(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'CANCELLED']);

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
  const userTools = normalizeUserTools(options.tools);
  return {
    name: 'e2e-default-agent',
    version: '1',
    async runStep(context: StepExecutorContext): Promise<StepVerdict> {
      const model = (options.model ?? context.model) as LanguageModel | undefined;
      if (model === undefined) {
        throw new AgentError(
          'MODEL_UNAVAILABLE',
          'the default agent requires a model: set agent.model, E2E_MODEL, or createAgent({ model })',
        );
      }
      const state: LoopState = { verdict: undefined, hardStop: undefined };
      const tools: ToolSet = {
        ...userTools,
        ...buildDefaultTools(context, state),
      };
      const maxTurns = options.maxTurns ?? context.budgets.maxModelCalls;
      const loop = new ToolLoopAgent({
        model,
        instructions: buildInstructions(context, options.system),
        tools,
        toolChoice: 'required',
        stopWhen: [
          () => state.verdict !== undefined || state.hardStop !== undefined,
          stepCountIs(maxTurns),
        ],
      });
      const observation = await context.observe();
      try {
        await loop.generate({
          prompt: buildPrompt(context, observation),
          abortSignal: context.signal,
          onStepEnd: ({ usage }) => {
            context.budgets.recordModelCall({
              ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
              ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
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
      if (isAgentError(cause) && HARD_STOP_CODES.has(cause.code)) {
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
        const blockable = new Set([
          'AUTH_CREDENTIAL_UNAVAILABLE',
          'APP_UNREACHABLE',
          'APP_NOT_OPEN',
          'POLICY_DENIED',
        ]);
        if (
          input.status === 'blocked' &&
          (input.errorCode === undefined || !blockable.has(input.errorCode))
        ) {
          return (
            'Rejected: a blocked verdict requires errorCode naming what blocked you ' +
            '(AUTH_CREDENTIAL_UNAVAILABLE, APP_UNREACHABLE, APP_NOT_OPEN, or POLICY_DENIED). ' +
            'If the application itself misbehaved, use status "failed" instead.'
          );
        }
        state.verdict = {
          status: input.status,
          summary: input.summary,
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        };
        return 'Step concluded.';
      },
    }),
  };
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

/** Unwraps `defineTool` values into the AI SDK toolset, guarding reserved names. */
function normalizeUserTools(
  tools: Readonly<Record<string, DefinedTool>> | undefined,
): ToolSet {
  if (tools === undefined) return {};
  const normalized: Record<string, ToolSet[string]> = {};
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
    normalized[name] = defined.tool;
  }
  return normalized;
}
