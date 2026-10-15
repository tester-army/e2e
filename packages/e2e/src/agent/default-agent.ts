/**
 * The built-in agent: the tool-loop chassis plus the grammar toolset, kept
 * deliberately small, built from an agents entry's options. Every mutating
 * tool returns what changed on screen; verdicts, budgets, hard stops, loop
 * guards, wind-down, and the transcript come from the chassis
 * (`tool-loop.ts`) unchanged. `createToolLoopExecutor` is the same loop with
 * a caller's own prompt and vocabulary.
 */

import type { Tool, ToolExecutionOptions, ToolSet } from 'ai';

import { BUILT_IN_AGENT } from './agent-brand.ts';
import { AgentError } from './error.ts';
import type { ReplayedPrefix, StepExecutor, StepExecutorContext } from './executor.ts';
import { interactiveNodeCount } from './observation.ts';
import { grammarTools } from './primitives.ts';
import { ScreenPresenter } from './screen-update.ts';
import { compactScreenHistory, compactScreenshotHistory } from './transcript-compaction.ts';
import { createToolLoopExecutor, type ToolLoopHelpers } from './tool-loop.ts';
import { toolAppliesTo, withToolContext } from './tool.ts';
import { boundToolOutput } from './tool-output.ts';
import type { AgentTool } from '../types.ts';

/**
 * The built-in agent's rules for its action tools (`createGrammarTools`): how
 * to read the screen and its changes, when to batch actions, and when a step
 * has passed. Exported for an executor that offers the same tools to a
 * model of its own.
 */
export const BASE_RULES = `You are an autonomous end-to-end testing agent executing exactly one test step against a real application.

Rules:
- Work only toward the given step; do not start the next step or explore beyond it.
- The screen is a tree of nodes with stable ids like "n42": a node keeps its id for as long as it exists, across every screen and change in this conversation. The first screen is sent whole. Every action result and every observe then reports what changed since the screen you last received, one line per node: "added" (a new node), "changed" (with what it read before), or "removed" (the node is gone; never target it again); a node not listed as removed is still there under the id you have. When most of the screen changed, the result sends the whole new screen instead, headed "Current screen", and it replaces what you had: target only the ids it lists. Never invent ids.
- Every action result already waited for the effect and contains the changes, so do not call observe after an action. Call observe only after waiting for something the last result showed in progress.
- You may issue several actions in one turn when each targets a node already on screen and no earlier action in the turn changes what a later one targets: fill several fields, then press the submit button as the last action. Actions run in order; each result reports its own changes. Anything that changes the page (a tap on a link or button, a navigation, a submit) should be the last action of its turn.
- If the target is not on screen, bring it on screen with the tools you have (scroll_to for a node the screen lists, scroll, navigate) or conclude. Scrolling may repeat (times) or be issued several times in one turn to move far; each result reports what came into the tree.
- tap is the default gesture for a listed control. The other verbs are offered only when this app's engine can perform them, and each one's description says what it is for; none of them makes a tap stronger.
- Pixel tools, when offered: screenshot attaches the viewport's pixels when the tree lacks what you need (a shape on a canvas, a pin on a map, a region of an image, a control inside a system sheet) or contradicts what you expect; once you have one, every action result carries a fresh screenshot so you can see what the action did. tap_at, hover_at, type_at, press_at, and select_at act at a point in the latest screenshot's pixel coordinates; a listed control under the point is acted on by its id. Prefer ids: tap, hover, type, press, and select by id whenever the screen lists the target, use the point tools only for a target the screen does not list, and take a screenshot before guessing a point rather than aiming from memory or from what you expect to be drawn.
- When type and press accept no target: a field the screen does not list still takes text. tap_at it to give it focus, then type without a target (and press Enter without a target to submit). A field the screen lists is typed by id, and a listed node that is not an input (a canvas, a widget with its own key handling) is focused and typed into through the keyboard by the same call: never spell a value out with one press per character. dismiss_keyboard, when offered, hides an on-screen keyboard covering the target.
- On a touch screen, a tap made while the keyboard is up may only close the keyboard; the result says so when the keyboard went away. Then act on the control again rather than concluding.
- Conclude "passed" only when the latest result shows the outcome the step asked for. A result that reports no change, or only the keyboard closing, means the decisive action did not land: act again or conclude "failed". A result that says only that no listed node changed has not ruled out a drawn change: take a screenshot, when offered, before deciding. Never describe an unchanged screen as the outcome.`;

/** One presenter per dispatched step, shared by the opening prompt and the tools that follow it. */
const presenters = new WeakMap<StepExecutorContext, ScreenPresenter>();

function presenterFor(context: StepExecutorContext): ScreenPresenter {
  let presenter = presenters.get(context);
  if (presenter === undefined) {
    presenter = new ScreenPresenter({ pixelsUnavailable: () => context.pixelsTainted });
    presenters.set(context, presenter);
  }
  return presenter;
}

/** What the built-in agent is built from: an agents entry's `system` and its validated `tools`. */
export interface BuiltInAgentOptions {
  /** Appended to the built-in execution rules; only the act loop reads it. */
  readonly system?: string | undefined;
  /** Project tools from `defineTool`, validated by config resolution. */
  readonly tools?: Readonly<Record<string, AgentTool>>;
}

/** Builds the built-in AI SDK step executor. */
export function createBuiltInAgent(options: BuiltInAgentOptions = {}): StepExecutor {
  const userTools = options.tools ?? {};
  const system = (): string =>
    [BASE_RULES, options.system]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join('\n\n');
  return createToolLoopExecutor({
    ...BUILT_IN_AGENT,
    system,
    prepareMessages: (messages) => compactScreenshotHistory(compactScreenHistory(messages)),
    tools: (context, helpers) => ({
      ...guardedTools(helpers, projectTools(context, userTools)),
      ...grammarTools(context, { guard: helpers.guard, screen: presenterFor(context) }),
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
  tools: Readonly<Record<string, AgentTool>>,
): ToolSet {
  const wrapped: Record<string, ToolSet[string]> = {};
  for (const [name, defined] of Object.entries(tools)) {
    // A tool scoped to other platforms is not offered, so the model never
    // learns a verb the surface cannot honor.
    if (!toolAppliesTo(defined, context.target.platform)) continue;
    // Config resolution admitted only defineTool values with an execute function.
    const tool = defined.tool as Tool;
    const execute = tool.execute!.bind(tool);
    const mutates = defined.annotations.mutates;
    wrapped[name] = {
      ...tool,
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
