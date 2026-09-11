/**
 * The default step executor: the tool-loop
 * chassis plus the grammar toolset, kept deliberately small. Every mutating
 * tool returns what changed on screen; verdicts, budgets, hard stops, loop
 * guards, wind-down, and the transcript come from the chassis
 * (`tool-loop.ts`) unchanged. `createToolLoopExecutor` is the same loop with
 * a caller's own prompt and vocabulary.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';

import type { SdkLanguageModel } from '../config/agent.ts';
import type { ProviderOptions } from '../types.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  RUNTIME_CODES,
  type ReplayedPrefix,
  type StepExecutor,
  type StepExecutorContext,
} from './executor.ts';
import { createGrammarTools } from './primitives.ts';
import { compactScreenHistory, ScreenPresenter } from './screen-update.ts';
import { createToolLoopExecutor, type ToolLoopHelpers } from './tool-loop.ts';
import type { DefinedTool } from './tool.ts';
import { isDefinedTool, toolAppliesTo, withToolContext } from './tool.ts';
import { boundToolOutput } from './tool-output.ts';

const BASE_RULES = `You are an autonomous end-to-end testing agent executing exactly one test step against a real application.

Rules:
- Work only toward the given step; do not start the next step or explore beyond it.
- The screen is a tree of nodes with stable ids like "n42": a node keeps its id for as long as it exists, across every screen and change in this conversation. The first screen is sent whole. Every action result and every observe then reports what changed since the screen you last received, one line per node: "added" (a new node), "changed" (with what it read before), or "removed" (the node is gone; never target it again); a node not listed as removed is still there under the id you have. When most of the screen changed, the result sends the whole new screen instead, headed "Current screen", and it replaces what you had: target only the ids it lists. Never invent ids.
- Every action result already waited for the effect and contains the changes, so do not call observe after an action. Call observe only after waiting for something the last result showed in progress.
- You may issue several actions in one turn when each targets a node already on screen and no earlier action in the turn changes what a later one targets: fill several fields, then press the submit button as the last action. Actions run in order; each result reports its own changes. Anything that changes the page (a tap on a link or button, a navigation, a submit) should be the last action of its turn.
- If the target is not on screen, bring it on screen with the tools you have (scroll, navigate) or conclude. Scrolling may repeat (times) or be issued several times in one turn to move far; each result reports what came into the tree.`;

/** One presenter per dispatched step, shared by the opening prompt and the tools that follow it. */
const presenters = new WeakMap<StepExecutorContext, ScreenPresenter>();

function presenterFor(context: StepExecutorContext): ScreenPresenter {
  let presenter = presenters.get(context);
  if (presenter === undefined) {
    presenter = new ScreenPresenter();
    presenters.set(context, presenter);
  }
  return presenter;
}

export interface CreateAgentOptions {
  /**
   * AI SDK language model, e.g. `gateway('openai/gpt-5.6-luna')` from `ai`;
   * defaults to the config-resolved `agent.model`.
   */
  readonly model?: SdkLanguageModel;
  /** Extra system guidance appended to the base execution rules. */
  readonly system?: string;
  /** Project tools from `defineTool`, merged with the default toolset. */
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  /** Upper bound on model turns per step; defaults to the model-call budget. */
  readonly maxTurns?: number;
  /**
   * AI SDK provider options passed to every model call (e.g. a thinking
   * level). Defaults to the config-resolved `agent.providerOptions`.
   */
  readonly providerOptions?: ProviderOptions;
}

/** Cross-realm identity marker for executors `createAgent` built. */
const DEFAULT_AGENT_MARKER = Symbol.for('e2e.default-agent.v1');

/**
 * The executor `createAgent` returns: the step executor plus the options it
 * was built from, readable so a host that composes another vocabulary on top
 * of a project's (`e2e explore` adds its finding tool to the project's tools)
 * starts from the same tools, guidance, model, and provider options.
 */
export interface DefaultAgent extends StepExecutor {
  /** What `createAgent` was given, with the tools validated. */
  readonly options: CreateAgentOptions;
}

/** True when an executor came from `createAgent`, in this or another realm. */
export function isDefaultAgent(value: unknown): value is DefaultAgent {
  return typeof value === 'object' && value !== null && DEFAULT_AGENT_MARKER in value;
}

/** Builds the default AI SDK step executor. */
export function createAgent(options: CreateAgentOptions = {}): DefaultAgent {
  const userTools = validateUserTools(options.tools);
  const system = [BASE_RULES, options.system]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n\n');
  const executor = createToolLoopExecutor({
    name: 'e2e-default-agent',
    version: '2',
    ...(options.model === undefined ? {} : { model: options.model }),
    system,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    prepareMessages: (messages) => compactScreenHistory(messages),
    tools: (context, helpers) => ({
      ...wrapUserTools(context, helpers, userTools),
      ...createGrammarTools(context, { guard: helpers.guard, screen: presenterFor(context) }),
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
      parts.push(presenterFor(context).initial(observation));
      return parts.join('\n\n');
    },
  });
  const agent: DefaultAgent = { ...executor, options: { ...options, tools: userTools } };
  Object.defineProperty(agent, DEFAULT_AGENT_MARKER, { value: true });
  return agent;
}

/**
 * The mid-step hand-off notice: prose summaries and a reason
 * token, replacing any ordinary prior-run hint. The agent continues from live
 * state; redoing a replayed action would double-commit a mutation.
 */
function formatReplayedPrefix(prefix: ReplayedPrefix): string {
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
      execute: async (input: never, executionOptions: ToolExecutionOptions<unknown>) => {
        if (helpers.concluding()) return 'The step is already concluding; no further actions run.';
        try {
          const result: unknown = await context.budgets.runTool({ name, mutates }, async () =>
            execute(input, withToolContext(executionOptions, {
              observe: (options) => {
                if (mutates) {
                  throw new AgentError('POLICY_DENIED', 'only read-only tools may request observations; observe in a separate tool call');
                }
                return context.observe(options);
              },
              attachScreenshot: (pixels, label) => context.attachScreenshot(pixels, label),
            })),
          );
          // A text result is bounded like every other thing the model reads;
          // structured results are the tool's own contract and pass through.
          return typeof result === 'string' ? boundToolOutput(result).text : result;
        } catch (cause) {
          if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) {
            helpers.reportHardStop(cause);
            return `HARD STOP (${cause.code}): ${cause.message}`;
          }
          return `Tool "${name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}
