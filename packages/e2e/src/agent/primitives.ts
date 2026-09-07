/**
 * The pieces the tool-loop chassis and `createAgent` are assembled from:
 *
 * - `createGrammarTools` — AI SDK tools over the harness action grammar;
 * - `createVerdictTool` — the `complete_step` tool and the closed blocked-code policy;
 * - `trackModelCalls` — step handlers that report usage to the harness budgets.
 *
 * Nothing here loads the `ai` package: an AI SDK tool is a plain object, so
 * the module is safe to import from a config that never calls a model.
 */

import type { StepResult, Tool, ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentErrorCode } from '../types.ts';
import { BLOCKABLE_CODES, type StepExecutorContext, type StepVerdict } from './executor.ts';
import { readCost } from './model/sdk.ts';

/** Codes the model may pick when concluding; runtime codes are runtime-assigned. */
const MODEL_ERROR_CODES = [
  'ACTION_FAILED',
  'AUTOMATION_UNSUPPORTED',
  'ASSERTION_FAILED',
  'AUTHENTICATION_FAILED',
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'AUTH_CREDENTIAL_INVALID',
  'ENVIRONMENT_UNAVAILABLE',
  'SEED_DATA_MISSING',
  'TEST_SETUP_FAILED',
  'APP_UNREACHABLE',
  'APP_NOT_OPEN',
  'POLICY_DENIED',
] as const satisfies readonly AgentErrorCode[];

/** The model-pickable codes a blocked verdict accepts; derived, never restated. */
const MODEL_BLOCKABLE_CODES = MODEL_ERROR_CODES.filter((code) => BLOCKABLE_CODES.has(code));

/** The verdict rules the built-in agent appends to its instructions. */
export const VERDICT_RULES = `Verdict rules:
- When the step's goal is achieved, or you are certain it cannot be, call complete_step exactly once.
- Verify outcomes with your tools before concluding; never guess success.
- "passed" means the application behaved as the step required. "failed" means it did not. "blocked" means credentials, the environment, or test setup prevented a product verdict — blocked says nothing about the product and requires an errorCode.`;

/**
 * A plain AI SDK function tool with its input typed from the schema — what
 * `tool()` from `ai` does, without loading `ai` to do it.
 */
function schemaTool<Schema extends z.ZodType>(definition: {
  readonly description: string;
  readonly inputSchema: Schema;
  readonly execute: (input: z.output<Schema>) => Promise<string>;
}): Tool {
  return definition;
}

/** The conclusion tool and the verdict it collected. */
export interface VerdictTool {
  /** The `complete_step` tool; add it to the toolset under that name. */
  readonly tool: Tool;
  /** The verdict once the model called the tool with an accepted one. */
  verdict(): StepVerdict | undefined;
  /** True once a verdict landed; a `stopWhen` condition for a raw loop. */
  concluded(): boolean;
}

/**
 * The `complete_step` verdict tool. A blocked verdict without a blockable
 * code is rejected back to the model, a passed verdict never carries a code,
 * and the first accepted verdict is final.
 */
export function createVerdictTool(): VerdictTool {
  let verdict: StepVerdict | undefined;
  const tool = schemaTool({
    description:
      'Conclude the step with the final verdict. passed = the application behaved as required and you verified it. failed = the application did not behave as required. blocked = credentials, environment, or test setup prevented a product verdict; blocked requires errorCode.',
    inputSchema: z.object({
      status: z.enum(['passed', 'failed', 'blocked']),
      summary: z
        .string()
        .min(1)
        .max(500)
        .describe('What you did and what you saw, in plain language'),
      errorCode: z.enum(MODEL_ERROR_CODES).optional(),
    }),
    execute: async (input) => {
      if (verdict !== undefined) return 'The step already concluded.';
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
      verdict = {
        status: input.status,
        summary: input.summary,
        ...(input.errorCode === undefined || input.status === 'passed'
          ? {}
          : { errorCode: input.errorCode }),
      };
      return 'Step concluded.';
    },
  });
  return {
    tool,
    verdict: () => verdict,
    concluded: () => verdict !== undefined,
  };
}

/** What a tool body runs under; the chassis supplies its loop policy here. */
export interface GrammarToolOptions {
  /**
   * Wraps every tool body. The default runs it as is, so a harness hard stop
   * (budget, timeout, cancel) propagates out of the tool; the chassis's guard
   * instead turns it into text and ends the loop.
   */
  readonly guard?: (body: () => Promise<string>) => Promise<string>;
}

/**
 * AI SDK tools over the harness action grammar, limited to the verbs the
 * target's backend declared. A verb the surface cannot honor is not offered
 * at all, so the model never learns vocabulary it can only be rejected on.
 * Every mutating tool returns the updated screen.
 */
export function createGrammarTools(
  context: StepExecutorContext,
  options: GrammarToolOptions = {},
): ToolSet {
  const guard = options.guard ?? ((body) => body());
  const { verbs } = context.target;

  /** Re-observes after a mutating action so the model always sees the result. */
  const acted = async (description: string): Promise<string> => {
    const observation = await context.observe();
    return `${description}\n\nUpdated screen (revision ${observation.revision}):\n${observation.text}`;
  };

  const target = z.string().min(1).describe('Node id from the newest observation, e.g. "n42"');

  const tools: ToolSet = {
    observe: schemaTool({
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
    tools['tap'] = schemaTool({
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
    tools['type'] = schemaTool({
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
    tools['press'] = schemaTool({
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
    tools['select'] = schemaTool({
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
      ? schemaTool({
          description: 'Scroll the viewport, or one scrollable node when target is given.',
          inputSchema: z.object({ direction, target: target.optional() }),
          execute: ({ direction: way, target: id }) =>
            guard(async () => {
              await context.actions.scroll(way, id === undefined ? undefined : { id });
              return acted(`Scrolled ${way}.`);
            }),
        })
      : schemaTool({
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
    tools['navigate'] = schemaTool({
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
    tools['type_secret'] = schemaTool({
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

/** Step handlers that report every model round trip to the harness budgets. */
export interface ModelCallTracker {
  /** Pass as `onStepStart`; marks the turn's start for its duration. */
  onStepStart(): void;
  /**
   * Pass as `onStepEnd` (or `onStepFinish`); records the turn's usage, cost,
   * and provenance. Throws `STEP_BUDGET_EXHAUSTED` past the model-call budget,
   * which ends a raw loop the same way it ends the chassis.
   */
  onStepEnd(step: Pick<StepResult<ToolSet>, 'usage' | 'providerMetadata'>): void;
}

/**
 * Model-call accounting for a loop the executor runs itself. `model` names
 * the provider and model id in the report; pass the AI SDK model instance.
 */
export function trackModelCalls(
  context: StepExecutorContext,
  model?: { readonly provider?: string; readonly modelId?: string },
): ModelCallTracker {
  let turnStartedMs = Date.now();
  return {
    onStepStart: () => {
      turnStartedMs = Date.now();
    },
    onStepEnd: (step) => {
      const estimatedCostUsd = readCost(step.providerMetadata);
      context.budgets.recordModelCall({
        ...(step.usage.inputTokens === undefined ? {} : { inputTokens: step.usage.inputTokens }),
        ...(step.usage.outputTokens === undefined ? {} : { outputTokens: step.usage.outputTokens }),
        durationMs: Date.now() - turnStartedMs,
        ...(typeof model?.provider === 'string' ? { provider: model.provider } : {}),
        ...(typeof model?.modelId === 'string' ? { modelId: model.modelId } : {}),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      });
    },
  };
}
