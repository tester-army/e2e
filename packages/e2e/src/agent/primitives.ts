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
import type { VisionDegradation } from '../run/steps.ts';
import {
  isRuntimeHardStop,
  BLOCKABLE_CODES,
  type ExecutorPixels,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import { cacheTokenFields, readCost } from './model/sdk.ts';
import { imagePointToViewport } from './point-tap.ts';
import { ScreenPresenter } from './screen-update.ts';

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

/**
 * Ceiling on a verdict summary. Generous on purpose: the summary is a
 * handoff, and a long one is bounded again by the ledger, whereas a schema
 * that rejects it costs a repair turn — a page-narrating model paid one on a
 * third of its steps at a 500-character cap. The description asks for less.
 */
const MAX_VERDICT_SUMMARY_CHARS = 2_000;

/** Screens one scroll call may move; a windowed list of thousands of rows still needs a better verb. */
const MAX_SCROLL_TIMES = 5;

/**
 * Keys whose whole effect is where the focus or the caret sits, which the
 * tree does not record. An unchanged screen after one of these is the normal
 * outcome, not a control that did nothing.
 */
const FOCUS_ONLY_KEYS = /^(?:(?:Shift|Control|Alt|Meta)\+)*(?:Tab|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/i;

function movesFocusOnly(key: string): boolean {
  return FOCUS_ONLY_KEYS.test(key.trim());
}

/** The model-pickable codes a blocked verdict accepts; derived, never restated. */
const MODEL_BLOCKABLE_CODES = MODEL_ERROR_CODES.filter((code) => BLOCKABLE_CODES.has(code));

/** The verdict rules the built-in agent appends to its instructions. */
export const VERDICT_RULES = `Verdict rules:
- When the step's goal is achieved, or you are certain it cannot be, call complete_step exactly once.
- Conclude from the newest screen and changes already in this conversation; never guess success. Observe again before concluding only when the newest result shows work still in progress (a spinner, "Saving…", a pending state).
- "passed" means the application behaved as the step required. "failed" means it did not. "blocked" means credentials, the environment, or test setup prevented a product verdict — blocked says nothing about the product and requires an errorCode.`;

/**
 * A plain AI SDK function tool with its input typed from the schema — what
 * `tool()` from `ai` does, without loading `ai` to do it.
 */
function schemaTool<Schema extends z.ZodType, Output = string>(definition: {
  readonly description: string;
  readonly inputSchema: Schema;
  readonly execute: (input: z.output<Schema>) => Promise<Output>;
  /** Maps a structured result onto model content; a string result needs none. */
  readonly toModelOutput?: (options: { readonly output: Output }) => ModelOutput;
}): Tool {
  return definition as Tool;
}

/** The model-facing shape of a tool result: text, or text with a screenshot attached. */
type ModelOutput =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'content';
      readonly value: ({ readonly type: 'text'; readonly text: string } | { readonly type: 'file'; readonly data: { readonly type: 'data'; readonly data: string }; readonly mediaType: string })[];
    };

/**
 * What a grammar tool hands back: the screen as text, plus the screenshot
 * when the step is showing pixels. The image rides the tool result itself,
 * so the model sees what its action did rather than a description of it.
 */
type ScreenOutput = string | { readonly text: string; readonly pixels: ExecutorPixels };

function screenModelOutput({ output }: { readonly output: ScreenOutput }): ModelOutput {
  if (typeof output === 'string') return { type: 'text', value: output };
  return {
    type: 'content',
    value: [
      { type: 'text', text: output.text },
      {
        type: 'file',
        data: { type: 'data', data: Buffer.from(output.pixels.data).toString('base64') },
        mediaType: output.pixels.mediaType,
      },
    ],
  };
}

/** The line under a screenshot: its pixel size and the coordinate space `tap_at` reads. */
export function screenshotNote(pixels: Pick<ExecutorPixels, 'width' | 'height' | 'scale'>): string {
  return `Screenshot attached: ${String(pixels.width)} by ${String(pixels.height)} pixels${
    pixels.scale === 1 ? '' : ` (${String(pixels.scale)} per CSS pixel)`
  }. tap_at takes coordinates in this image: x from the left edge, y from the top edge.`;
}

/** Why pixels did not reach the model, and what to do instead. */
function withheldAdvice(code: VisionDegradation | undefined): string {
  switch (code) {
    case 'PIXEL_TAINTED':
      return 'a secret was filled in this attempt, so no pixels leave the runner until it ends (PIXEL_TAINTED). Work from the tree and tap listed nodes by id.';
    case 'MASKING_UNPROVEN':
      return 'the engine could not prove every secure field on screen masked (MASKING_UNPROVEN). Work from the tree and tap listed nodes by id.';
    default:
      return 'this engine captures no pixels (UNSUPPORTED_CAPABILITY). Work from the tree and tap listed nodes by id.';
  }
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
        .max(MAX_VERDICT_SUMMARY_CHARS)
        .describe(
          'One to three sentences for the next step: what you did, what the screen shows now, and any value it will need (a name or id you created, a message you saw). No page narration; under 400 characters.',
        ),
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
  readonly guard?: <T>(body: () => Promise<T>) => Promise<T | string>;
  /**
   * Renders screens for the model and remembers what it has seen, so every
   * result after the first reports the changes rather than the whole tree.
   * Shared with the opening prompt by `createAgent`; a fresh one per step
   * otherwise.
   */
  readonly screen?: ScreenPresenter;
}

/**
 * AI SDK tools over the harness action grammar, limited to the verbs the
 * target's engine declared. A verb the surface cannot honor is not offered
 * at all, so the model never learns vocabulary it can only be rejected on.
 *
 * Every action returns what it changed on screen. Tool bodies run one at a
 * time in call order, action and its look at the result together, so a turn
 * that batches several actions gets one coherent result per action rather
 * than every result describing the state after the last one.
 */
/**
 * Every name `createGrammarTools` may hand out. The grammar owns these in the
 * model's vocabulary whatever the engine declares, so a project tool cannot
 * take one: it would be silently shadowed on one engine and live on another.
 */
export const GRAMMAR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'observe',
  'tap',
  'type',
  'type_secret',
  'press',
  'select',
  'scroll',
  'navigate',
  'screenshot',
  'tap_at',
]);

export function createGrammarTools(
  context: StepExecutorContext,
  options: GrammarToolOptions = {},
): ToolSet {
  const guard = options.guard ?? ((body) => body());
  const screen: ScreenPresenter = options.screen ?? new ScreenPresenter();
  const { verbs } = context.target;

  // The chain is always already settled-to-undefined, so a failed body
  // reaches its own caller and never poisons the queue (same idiom as the
  // dispatch's own serialization).
  let chain: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(body: () => Promise<T>): Promise<T> => {
    const run = chain.then(body);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * The screen after an action, as the model reads it: the changes since the
   * screen it holds, and, once the step is showing pixels, a fresh screenshot
   * of them. Pixels the harness withholds mid-step (a secret was just filled)
   * are reported once as text.
   */
  const present = async (lead: string, expectChange?: boolean): Promise<ScreenOutput> => {
    const observation = await context.observe({ pixels: screen.showingPixels });
    if (!screen.showingPixels) return screen.update(observation, { lead, expectChange });
    // In pixel mode an unchanged tree is not a failed action: what the action
    // did may be drawn, not listed, so the screenshot is the evidence.
    const text = screen.update(observation, { lead, expectChange: false });
    if (observation.pixels === undefined) {
      return `${text}\n\nNo screenshot this time: ${withheldAdvice(observation.pixelsWithheld)}`;
    }
    screen.attached(observation);
    return { text: `${text}\n\n${screenshotNote(observation.pixels)}`, pixels: observation.pixels };
  };

  /**
   * Performs one action and reads its result. A failed action still returns
   * the screen, so the model can act on a stale-id or not-found failure at
   * once instead of spending a turn to observe; runtime hard stops propagate
   * to the guard, which ends the loop. The guard runs inside the queue, so a
   * batched call that queued behind a hard stop or a verdict is skipped when
   * its turn comes rather than acted on because it was queued in time. The
   * action may return its own lead line, for a result only it can describe.
   */
  const acting = (
    description: string,
    action: () => Promise<string | void>,
    expectChange = true,
  ): Promise<ScreenOutput> =>
    inOrder(() =>
      guard(async () => {
        let lead = description;
        try {
          lead = (await action()) ?? description;
        } catch (cause) {
          if (isRuntimeHardStop(cause)) throw cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          return present(`${description} failed: ${message}`);
        }
        return present(lead, expectChange);
      }),
    );

  const target = z
    .string()
    .min(1)
    .describe('Node id from any screen in this conversation that is still present, e.g. "n42"');

  const tools: ToolSet = {
    observe: schemaTool({
      description:
        'Look at the screen again and get what changed since the screen you last received. Action results already include their changes, so call this only after waiting for something in progress, never right after an action.',
      inputSchema: z.object({}),
      execute: () => inOrder(() => guard(() => present('Observed.', false))),
      toModelOutput: screenModelOutput,
    }),
  };
  if (verbs.has('tap')) {
    tools['tap'] = schemaTool({
      description:
        'Tap or click one node. The result waits for the effect (a navigation, a route change, a submit) and reports what changed.',
      inputSchema: z.object({ target }),
      execute: ({ target: id }) => acting(`Tapped #${id}.`, () => context.actions.tap({ id })),
      toModelOutput: screenModelOutput,
    });
  }
  if (verbs.has('type')) {
    tools['type'] = schemaTool({
      description: 'Type a plain-text value into one input node, replacing its current value. Several fields can be typed in one turn.',
      inputSchema: z.object({ target, value: z.string() }),
      execute: ({ target: id, value }) =>
        acting(`Typed into #${id}.`, () => context.actions.type({ id }, value)),
    });
  }
  if (verbs.has('press')) {
    tools['press'] = schemaTool({
      description: 'Send one key (e.g. "Enter", "Escape", "Tab") to one node.',
      inputSchema: z.object({ target, key: z.string().min(1).max(64) }),
      execute: ({ target: id, key }) =>
        acting(`Pressed ${key} on #${id}.`, () => context.actions.press({ id }, key), !movesFocusOnly(key)),
    });
  }
  if (verbs.has('select')) {
    tools['select'] = schemaTool({
      description: 'Pick one option from a select-like control by its visible label.',
      inputSchema: z.object({ target, value: z.string().min(1) }),
      execute: ({ target: id, value }) =>
        acting(`Selected "${value}" in #${id}.`, () => context.actions.select({ id }, value)),
    });
  }
  if (verbs.has('scroll')) {
    const direction = z.enum(['up', 'down', 'left', 'right']);
    const times = z
      .number()
      .int()
      .min(1)
      .max(MAX_SCROLL_TIMES)
      .optional()
      .describe(`How many screens to scroll in this one call, 1 to ${String(MAX_SCROLL_TIMES)}; default 1. Use more to move far down a long list or feed.`);
    // Each repeat is one recorded action against the budget, paced like a
    // separate call, so a lazy list gets to render between screens.
    const scrolling = async (way: 'up' | 'down' | 'left' | 'right', id: string | undefined, count: number) => {
      for (let repeat = 0; repeat < count; repeat += 1) {
        await context.actions.scroll(way, id === undefined ? undefined : { id });
        if (repeat < count - 1) await context.observe();
      }
    };
    const scrolled = (way: string, count: number) =>
      count === 1 ? `Scrolled ${way}.` : `Scrolled ${way} ${String(count)} screens.`;
    // Node-targeted scrolling rides `perform`; without it only the viewport scrolls.
    tools['scroll'] = verbs.has('tap')
      ? schemaTool({
          description:
            'Scroll the viewport, or one scrollable node when target is given. The result reports the rows that came into or left the tree.',
          inputSchema: z.object({ direction, target: target.optional(), times }),
          execute: ({ direction: way, target: id, times: count }) =>
            acting(scrolled(way, count ?? 1), () => scrolling(way, id, count ?? 1), false),
        })
      : schemaTool({
          description: 'Scroll the viewport. The result reports the rows that came into or left the tree.',
          inputSchema: z.object({ direction, times }),
          execute: ({ direction: way, times: count }) =>
            acting(scrolled(way, count ?? 1), () => scrolling(way, undefined, count ?? 1), false),
        });
  }
  if (verbs.has('navigate')) {
    tools['navigate'] = schemaTool({
      description: 'Navigate to a URL or app-relative path within the allowed origins.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) => acting(`Navigated to ${url}.`, () => context.actions.navigate(url)),
      toModelOutput: screenModelOutput,
    });
  }
  // The pixel verbs are offered while pixels can still leave the runner. Once
  // a secret was filled in the attempt they could only decline, and a verb
  // that is absent costs the model nothing where one that declines costs a
  // turn. tap_at lands either as a tap by id or as a bare point, so it needs
  // one of the two; screenshot needs only the observation every step has.
  if (!context.pixelsTainted) {
    tools['screenshot'] = schemaTool({
      description:
        'Attach a screenshot of the current viewport. Use it when the screen lists too little to act on (a canvas, a map, an image, a game, a system sheet) or contradicts what you expect. From then on every action result carries a fresh screenshot too, so you can see what each action did.',
      inputSchema: z.object({}),
      execute: () =>
        inOrder(() =>
          guard(async () => {
            const observation = await context.observe({ pixels: true });
            if (observation.pixels === undefined) {
              return `No screenshot: ${withheldAdvice(observation.pixelsWithheld)}`;
            }
            screen.attached(observation);
            return {
              text: `${screen.update(observation, { lead: 'Screenshot taken.' })}\n\n${screenshotNote(observation.pixels)}`,
              pixels: observation.pixels,
            };
          }),
        ),
      toModelOutput: screenModelOutput,
    });
    if (verbs.has('tap') || verbs.has('tapAt')) {
      tools['tap_at'] = schemaTool({
        description:
          'Tap a point in the latest screenshot, given as pixel coordinates in that image (x from the left edge, y from the top edge). Aim for the center of the target. A listed control under the point is tapped by its id; otherwise the bare point is tapped' +
          (verbs.has('tapAt') ? '.' : ', which this engine cannot do: the point must land on a listed control.') +
          ' Last resort: when the screen lists the target, tap it by id.',
        inputSchema: z.object({ x: z.number(), y: z.number() }),
        execute: ({ x, y }) => {
          const shot = screen.latestScreenshot;
          if (shot === undefined) {
            return Promise.resolve(
              'No screenshot has been taken in this step: tap_at coordinates are pixels of the latest screenshot. Call screenshot first, or tap a listed node by id.',
            );
          }
          const point = imagePointToViewport({ x, y }, shot.pixels, shot.viewport);
          return acting(`tap_at (${String(x)}, ${String(y)})`, async () => (await context.actions.tapAt(point)).summary);
        },
        toModelOutput: screenModelOutput,
      });
    }
  }
  // Offered only when the step declared secrets and the surface can fill: an
  // empty vocabulary is better than a tool the model can only be rejected on.
  if (verbs.has('typeSecret') && context.step.secrets.length > 0) {
    tools['type_secret'] = schemaTool({
      description:
        'Fill one declared secret credential into a secure input field; the plaintext never passes through you and never shows on screen. Available: ' +
        context.step.secrets.map((secret) => `"${secret.name}" (${secret.purpose})`).join(', ') +
        '.',
      inputSchema: z.object({ target, name: z.string().min(1) }),
      execute: ({ target: id, name }) =>
        acting(
          `Filled secret "${name}" into #${id}; secure values never show on screen.`,
          () => context.actions.typeSecret({ id }, name),
          false,
        ),
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
        ...cacheTokenFields(step.usage),
        startedAt: new Date(turnStartedMs).toISOString(),
        durationMs: Date.now() - turnStartedMs,
        ...(typeof model?.provider === 'string' ? { provider: model.provider } : {}),
        ...(typeof model?.modelId === 'string' ? { modelId: model.modelId } : {}),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      });
    },
  };
}
