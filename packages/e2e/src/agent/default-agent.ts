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
import { AgentError } from './error.ts';
import type { ReplayedPrefix, StepExecutor, StepExecutorContext } from './executor.ts';
import { interactiveNodeCount } from './observation.ts';
import { createGrammarTools, GRAMMAR_TOOL_NAMES } from './primitives.ts';
import { ScreenPresenter } from './screen-update.ts';
import { compactScreenHistory, compactScreenshotHistory } from './transcript-compaction.ts';
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
- If the target is not on screen, bring it on screen with the tools you have (scroll, navigate) or conclude. Scrolling may repeat (times) or be issued several times in one turn to move far; each result reports what came into the tree.
- Pixel tools, when offered: screenshot attaches the viewport's pixels when the tree lacks what you need (a shape on a canvas, a pin on a map, a region of an image, a control inside a system sheet) or contradicts what you expect; once you have one, every action result carries a fresh screenshot so you can see what the action did. tap_at, type_at, press_at, and select_at act at a point in the latest screenshot's pixel coordinates; a listed control under the point is acted on by its id. Prefer ids: tap, type, press, and select by id whenever the screen lists the target, use the point tools only for a target the screen does not list, and take a screenshot before guessing a point rather than aiming from memory or from what you expect to be drawn.
- When type and press accept no target: a field the screen does not list still takes text. tap_at it to give it focus, then type without a target (and press Enter without a target to submit). A field the screen lists is typed by id, and a listed node that is not an input (a canvas, a widget with its own key handling) is focused and typed into through the keyboard by the same call: never spell a value out with one press per character. dismiss_keyboard, when offered, hides an on-screen keyboard covering the target.`;

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
  /**
   * The model that judges `assert`, `waitFor`, and `extract` for this agent;
   * defaults to `model`. Naming a second model here keeps the grader apart
   * from the actor: the judge never sees the act loop's transcript, and with
   * its own model it does not share the actor's blind spots either.
   */
  readonly judge?: SdkLanguageModel;
  /** Extra system guidance appended to the base execution rules. */
  readonly system?: string;
  /** Project tools from `defineTool`, merged with the default toolset. */
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  /** Upper bound on model turns per step; defaults to the model-call budget. */
  readonly maxTurns?: number;
  /** AI SDK provider options passed to every model call (e.g. a thinking level). */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
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
  /** The project tools, validated; what a host outside the model loop (`e2e mcp`) serves. */
  readonly tools: Readonly<Record<string, DefinedTool>>;
}

/** True when an executor came from `createAgent`, in this or another realm. */
export function isDefaultAgent(value: unknown): value is DefaultAgent {
  return typeof value === 'object' && value !== null && DEFAULT_AGENT_MARKER in value;
}

/** Builds the default AI SDK step executor. */
export function createAgent(options: CreateAgentOptions = {}): DefaultAgent {
  const userTools = validateUserTools(options.tools);
  const system = (): string =>
    [BASE_RULES, options.system]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join('\n\n');
  const executor = createToolLoopExecutor({
    name: 'e2e-default-agent',
    version: '2',
    ...(options.model === undefined ? {} : { model: options.model }),
    system,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    prepareMessages: (messages) => compactScreenshotHistory(compactScreenHistory(messages)),
    tools: (context, helpers) => ({
      ...guardedTools(helpers, projectTools(context, userTools)),
      ...createGrammarTools(context, { guard: helpers.guard, screen: presenterFor(context) }),
    }),
    buildPrompt: async (context) => {
      // The opening look is tree-only, unless pixels are allowed and no
      // listed interactive node exists at all: then the opening prompt
      // carries a screenshot, because the tree describes a canvas, a game,
      // or a semantics-free native screen too poorly to act on, and the model
      // would only spend a turn asking for one. One listed control is enough
      // to leave the decision to the model; a small page is not a blind one.
      let observation = await context.observe();
      if (!context.pixelsTainted && observation.pixels === undefined && interactiveNodeCount(observation) === 0) {
        observation = await context.observe({ pixels: true });
      }
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
      const opening = presenterFor(context).open(observation);
      if (typeof opening === 'string') return [...parts, opening].join('\n\n');
      return [
        {
          role: 'user',
          content: [
            { type: 'text', text: [...parts, opening.text].join('\n\n') },
            { type: 'file', data: opening.pixels.data, mediaType: opening.pixels.mediaType },
          ],
        },
      ];
    },
  });
  const agent: DefaultAgent = {
    ...executor,
    ...(options.judge === undefined ? {} : { judge: options.judge }),
    options: { ...options, tools: userTools },
    tools: userTools,
  };
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
    if (name === 'complete_step' || GRAMMAR_TOOL_NAMES.has(name)) {
      throw new AgentError('POLICY_DENIED', `the ${name} tool name is reserved for the agent's own tools`);
    }
    if (defined.tool.execute === undefined) {
      throw new AgentError('POLICY_DENIED', `tool "${name}" has no execute function`);
    }
  }
  return tools;
}

/**
 * The project tools that apply to the step's platform, run through the same
 * accounting pipeline as the grammar: every call is recorded, a mutating tool
 * consumes an action-budget slot (refused before it runs once the ceiling is
 * reached, consumed whether it succeeds or fails, exactly like a grammar
 * action), and a text result is bounded like everything else the model reads.
 * Failures propagate: the model loop turns them into text through its guard,
 * and a host outside the loop reports them its own way.
 */
export function projectTools(
  context: StepExecutorContext,
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
      },
    } as ToolSet[string];
  }
  return wrapped;
}

/** Runs each tool under the loop's guard: nothing after the verdict, hard stops end the loop, other failures become text. */
function guardedTools(helpers: ToolLoopHelpers, tools: ToolSet): ToolSet {
  const guarded: Record<string, ToolSet[string]> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute!.bind(tool);
    guarded[name] = {
      ...tool,
      execute: (input: never, options: ToolExecutionOptions<unknown>) =>
        helpers.guard(async () => execute(input, options), `Tool "${name}"`),
    } as ToolSet[string];
  }
  return guarded;
}
