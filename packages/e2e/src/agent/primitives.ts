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
import type { ViewportPoint } from '../engine/surface.ts';
import { hasCause } from '../internal/errors.ts';
import type { AgentErrorCode } from '../types.ts';
import { isRuntimeHardStop, BLOCKABLE_CODES, type StepExecutorContext, type StepVerdict } from './executor.ts';
import { cacheTokenFields, readCost } from './model/sdk.ts';
import { OperationQueue } from './operation-queue.ts';
import { imagePointToViewport } from './point-tap.ts';
import { ScreenPresenter, type ScreenOutput, type ScreenUpdateOptions } from './screen-update.ts';

/** Codes the model may pick when concluding; runtime codes are runtime-assigned. */
const MODEL_ERROR_CODES = [
  'ACTION_FAILED',
  'AUTOMATION_UNSUPPORTED',
  'ASSERTION_FAILED',
  'AUTHENTICATION_FAILED',
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'AUTH_CREDENTIAL_INVALID',
  'SECRET_UNAVAILABLE',
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
const MAX_SCROLL_TIMES = 20;

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
 * A grammar tool: its result is a rendered screen, text or text with the
 * screenshot attached as a file part, so every one encodes its output the
 * same way. A tool that skipped the encoder would hand the model the image
 * bytes as JSON the first time an action ran in pixel mode.
 */
function screenTool<Schema extends z.ZodType>(definition: {
  readonly description: string;
  readonly inputSchema: Schema;
  readonly execute: (input: z.output<Schema>) => Promise<ScreenOutput>;
}): Tool {
  return schemaTool({ ...definition, toModelOutput: screenModelOutput });
}

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
  'type_at',
  'press_at',
  'select_at',
  'dismiss_keyboard',
]);

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
export function createGrammarTools(
  context: StepExecutorContext,
  options: GrammarToolOptions = {},
): ToolSet {
  const { guard, screen, verbs, inOrder, present, acting } = verbKit(context, options);

  const target = z
    .string()
    .min(1)
    .describe('Node id from any screen in this conversation that is still present, e.g. "n42"');

  const tools: ToolSet = {
    observe: screenTool({
      description:
        'Look at the screen again and get what changed since the screen you last received. Action results already include their changes, so call this only after waiting for something in progress, never right after an action.',
      inputSchema: z.object({}),
      execute: () => inOrder(() => guard(() => present('Observed.', { expectChange: false }))),
    }),
  };
  if (verbs.has('tap')) {
    tools['tap'] = screenTool({
      description:
        'Tap or click one node. The result waits for the effect (a navigation, a route change, a submit) and reports what changed.',
      inputSchema: z.object({ target }),
      execute: ({ target: id }) => acting(`Tapped #${id}.`, () => context.actions.tap({ id })),
    });
  }
  // Keyboard input to the focused field is offered next to the node-targeted
  // verbs when the engine has a keyboard: it is how a field the tree does not
  // list (drawn, or flattened out of a platform's tree) gets its text after a
  // tap_at gave it focus, and how a key reaches a screen with no node to aim at.
  const focused = verbs.has('typeText');
  if (verbs.has('type') || focused) {
    tools['type'] = screenTool({
      description: focused
        ? 'Type a plain-text value into one input node, or into whatever has focus when target is omitted. With target the value replaces the node\'s value. After tap_at on a field the screen does not list, call type with NO target (not the document or a container id): the value is inserted at the caret of the focused field; set replace to clear it first. Several fields can be typed in one turn.'
        : 'Type a plain-text value into one input node, replacing its current value. Several fields can be typed in one turn.',
      inputSchema: z.object({
        target: verbs.has('type') && focused ? target.optional() : verbs.has('type') ? target : z.undefined().optional(),
        value: z.string(),
        ...(focused ? { replace: z.boolean().optional().describe('Without target: select all and delete before typing, for a field that visibly holds text you must remove; default false. Leave it off for an empty field.') } : {}),
      }),
      execute: ({ target: id, value, ...rest }) =>
        id === undefined
          ? acting('Typed into the focused field.', () =>
              context.actions.typeText(value, { replace: (rest as { replace?: boolean }).replace === true }),
            )
          : acting(`Typed into #${id}.`, () => typeIntoNode(context, { id }, value, `#${id}`)),
    });
  }
  if (verbs.has('press') || verbs.has('pressKey')) {
    const both = verbs.has('press') && verbs.has('pressKey');
    tools['press'] = screenTool({
      description: both
        ? 'Send one key (e.g. "Enter", "Escape", "Tab") to one node, or to whatever has focus when target is omitted.'
        : verbs.has('press')
          ? 'Send one key (e.g. "Enter", "Escape", "Tab") to one node.'
          : 'Send one key (e.g. "Enter", "Escape", "Tab") to whatever has focus.',
      inputSchema: z.object({
        target: both ? target.optional() : verbs.has('press') ? target : z.undefined().optional(),
        key: z.string().min(1).max(64),
      }),
      execute: ({ target: id, key }) =>
        id === undefined
          ? acting(`Pressed ${key} on the focused field.`, () => context.actions.pressKey(key), { expectChange: !movesFocusOnly(key) })
          : acting(`Pressed ${key} on #${id}.`, () => context.actions.press({ id }, key), { expectChange: !movesFocusOnly(key) }),
    });
  }
  if (verbs.has('dismissKeyboard')) {
    tools['dismiss_keyboard'] = screenTool({
      description: 'Hide the on-screen keyboard when it covers what you need to reach.',
      inputSchema: z.object({}),
      execute: () => acting('Dismissed the keyboard.', () => context.actions.dismissKeyboard(), { expectChange: false, keyboardNote: false }),
    });
  }
  if (verbs.has('select')) {
    tools['select'] = screenTool({
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
    const scrolled = (way: string, count: number) =>
      count === 1 ? `Scrolled ${way}.` : `Scrolled ${way} ${String(count)} screens.`;
    // Each repeat is one recorded action against the budget, paced like a
    // separate call, so a lazy list gets to render between screens.
    const scrolling = async (way: 'up' | 'down' | 'left' | 'right', id: string | undefined, count: number): Promise<void> => {
      for (let repeat = 0; repeat < count; repeat += 1) {
        if (repeat > 0) await context.observe();
        await context.actions.scroll(way, id === undefined ? undefined : { id });
      }
    };
    // Node-targeted scrolling rides `perform`; without it only the viewport scrolls.
    tools['scroll'] = verbs.has('tap')
      ? screenTool({
          description:
            'Scroll the viewport, or one scrollable node when target is given. The result reports the rows that came into or left the tree.',
          inputSchema: z.object({ direction, target: target.optional(), times }),
          execute: ({ direction: way, target: id, times: count }) =>
            acting(scrolled(way, count ?? 1), () => scrolling(way, id, count ?? 1), { expectChange: false }),
        })
      : screenTool({
          description: 'Scroll the viewport. The result reports the rows that came into or left the tree.',
          inputSchema: z.object({ direction, times }),
          execute: ({ direction: way, times: count }) =>
            acting(scrolled(way, count ?? 1), () => scrolling(way, undefined, count ?? 1), { expectChange: false }),
        });
  }
  if (verbs.has('navigate')) {
    tools['navigate'] = screenTool({
      description: 'Navigate to a URL or an app-relative path.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: ({ url }) => acting(`Navigated to ${url}.`, () => context.actions.navigate(url)),
    });
  }
  // The pixel verbs are offered while pixels can still leave the runner. Once
  // a secret was filled in the attempt they could only decline, and a verb
  // that is absent costs the model nothing where one that declines costs a
  // turn. They are the fallback for a target the tree does not list: every
  // point is hit-tested against the tree the runner holds, so a listed
  // control under it is acted on by id, policed and recorded like any other
  // action, and only a point on nothing listed reaches the engine as a bare
  // point (tap) or through the keyboard (type, press).
  if (!context.pixelsTainted) {
    tools['screenshot'] = screenTool({
      description:
        'Attach a screenshot of the current viewport. Use it when the screen lists too little to act on (a canvas, a map, an image, a game, a system sheet) or contradicts what you expect. From then on every action result carries a fresh screenshot too, so you can see what each action did.',
      inputSchema: z.object({}),
      execute: () => inOrder(() => guard(async () => screen.present(await context.observe({ pixels: true })))),
    });
    Object.assign(tools, createPointTools(context, { screen, acting }));
  }
  // Offered only when the step declared secrets and the surface can fill: an
  // empty vocabulary is better than a tool the model can only be rejected on.
  if (verbs.has('typeSecret') && context.step.secrets.length > 0) {
    tools['type_secret'] = screenTool({
      description:
        'Fill one declared secret into an input by its name; the plaintext never passes through you. A password fills only a password field; a generic-secret fills any editable input. Available: ' +
        context.step.secrets.map((secret) => `"${secret.name}" (${secret.purpose})`).join(', ') +
        '.',
      inputSchema: z.object({ target, name: z.string().min(1) }),
      execute: ({ target: id, name }) =>
        acting(
          `Filled secret "${name}" into #${id}; its value is masked in every observation.`,
          () => context.actions.typeSecret({ id }, name),
          { expectChange: false },
        ),
    });
  }
  return tools;
}

/**
 * Types into one listed node. A node the engine cannot fill (a focusable
 * canvas, a custom widget with its own key handling, or a container the
 * model named after a tap_at) still takes keystrokes when the engine has a
 * keyboard: the node is tapped so it holds focus, then the value goes to the
 * focused field. The tap comes first because whatever had focus before may be
 * an unrelated field an earlier action left focused, and typing into it
 * would corrupt that field while reporting success on this node. Returns a
 * lead when it took that path.
 */
async function typeIntoNode(
  context: StepExecutorContext,
  target: { readonly id: string },
  value: string,
  label: string,
): Promise<string | undefined> {
  try {
    await context.actions.type(target, value);
    return undefined;
  } catch (cause) {
    if (isRuntimeHardStop(cause) || !context.target.verbs.has('typeText') || !isNotFillable(cause)) throw cause;
  }
  await context.actions.tap(target);
  await context.actions.typeText(value, { replace: false });
  return `${label} is not an input; tapped it to focus it and typed through the keyboard.`;
}

/**
 * An engine's refusal to fill a node that is not a text input. The engine
 * codes it `NOT_ACTIONABLE`; the harness hands the executor an `ACTION_FAILED`
 * wrapping it, so the chain is walked for the code and the message.
 */
function isNotFillable(cause: unknown): boolean {
  return hasCause(
    cause,
    ({ code, message }) => code === 'NOT_ACTIONABLE' && typeof message === 'string' && /not an? <?(input|textarea)|not editable/i.test(message),
  );
}

/**
 * The point-addressed fallback verbs, offered next to the id-addressed
 * grammar while pixels may reach the model: `tap_at`, `type_at`, `press_at`,
 * and `select_at`, each taking a point in the latest screenshot for a target
 * the tree does not list. A point is hit-tested against the tree the harness
 * holds, so a control the tree lists is acted on by id underneath: policed,
 * recorded with a durable descriptor, and replayed like any other action. A
 * point on nothing listed taps as a bare point, and with a keyboard is
 * tapped to focus it and typed into. Before a screenshot the verbs cost
 * nothing: they answer with the line that says to take one.
 */
function createPointTools(
  context: StepExecutorContext,
  kit: Pick<ReturnType<typeof verbKit>, 'screen' | 'acting'>,
): ToolSet {
  const { screen, acting } = kit;
  const verbs = context.target.verbs;
  const keyboard = verbs.has('typeText');
  const x = z.number().describe('x in the latest screenshot, pixels from the left edge');
  const y = z.number().describe('y in the latest screenshot, pixels from the top edge');
  const at = (px: number, py: number) => `(${String(px)}, ${String(py)})`;

  /** A point the model read off the latest screenshot in viewport pixels, or the line to read when it has taken none. */
  const pointOf = (px: number, py: number, verb: string): ViewportPoint | string => {
    const shot = screen.latestScreenshot;
    if (shot === undefined) {
      return `No screenshot has been taken in this step: ${verb} coordinates are pixels of the latest screenshot. Call screenshot first, or act on a listed node by id.`;
    }
    return imagePointToViewport({ x: px, y: py }, shot.pixels, shot.viewport);
  };

  /**
   * The listed control at a point, for a verb that needs one. Nothing listed
   * there is an ordinary action failure the model reads and works around,
   * not a step failure.
   */
  const controlAt = async (point: ViewportPoint, verb: string) => {
    const hit = await context.actions.hitTest(point);
    if (hit.control === undefined) {
      throw new Error(`${hit.summary}; ${verb} needs a control the screen lists. Tap the target first, or aim at the control itself.`);
    }
    return { control: hit.control, summary: hit.summary };
  };

  /**
   * The control at a point for a verb that needs one, or, with a keyboard,
   * focus given to the point by a tap so the keyboard can reach whatever the
   * app put there: a field drawn on a canvas, an input flattened out of the
   * tree.
   */
  const focusAt = async (point: ViewportPoint, px: number, py: number, verb: string) => {
    const hit = await context.actions.hitTest(point);
    if (hit.control !== undefined) return { kind: 'control' as const, control: hit.control, summary: hit.summary };
    if (!keyboard) {
      throw new Error(`${hit.summary}; ${verb} needs a control the screen lists. Tap the target first, or aim at the control itself.`);
    }
    await context.actions.tapAt(point);
    return { kind: 'focused' as const, summary: `the field at ${at(px, py)} (tapped to focus it; ${hit.summary})` };
  };

  const tools: ToolSet = {};
  if (verbs.has('tap') || verbs.has('tapAt')) {
    tools['tap_at'] = screenTool({
      description:
        'Tap a point in the latest screenshot, given as pixel coordinates in that image (x from the left edge, y from the top edge). Aim for the center of the target. A listed control under the point is tapped by its id; otherwise the bare point is tapped' +
        (verbs.has('tapAt') ? '.' : ', which this engine cannot do: the point must land on a listed control.') +
        ' Last resort: when the screen lists the target, tap it by id.',
      inputSchema: z.object({ x, y }),
      execute: ({ x: px, y: py }) => {
        const point = pointOf(px, py, 'tap_at');
        if (typeof point === 'string') return Promise.resolve(point);
        return acting(`tap_at ${at(px, py)}`, async () => (await context.actions.tapAt(point)).summary);
      },
    });
  }
  if (verbs.has('type') || keyboard) {
    tools['type_at'] = screenTool({
      description: keyboard
        ? 'Type a plain-text value into the field at a point in the latest screenshot, for a field the screen does not list. A listed input under the point is filled by id, replacing its value; anything else is tapped to focus it and typed into through the keyboard, inserting at the caret unless replace is set. Last resort: when the screen lists the field, type by id.'
        : 'Type a plain-text value into the input at a point in the latest screenshot, replacing its value. Aim at the field itself; a point on nothing listed fails. Last resort: when the screen lists the field, type by id.',
      inputSchema: z.object({
        x,
        y,
        value: z.string(),
        ...(keyboard ? { replace: z.boolean().optional().describe('Select all and delete before typing, for a field that visibly holds text you must remove; default false. Leave it off for an empty field.') } : {}),
      }),
      execute: ({ x: px, y: py, value, ...rest }) => {
        const point = pointOf(px, py, 'type_at');
        if (typeof point === 'string') return Promise.resolve(point);
        return acting(`type_at ${at(px, py)}`, async () => {
          const found = await focusAt(point, px, py, 'type_at');
          if (found.kind === 'control') {
            const note = await typeIntoNode(context, found.control, value, found.summary);
            if (note !== undefined) return note;
          } else {
            await context.actions.typeText(value, { replace: (rest as { replace?: boolean }).replace === true });
          }
          return `Typed into ${found.summary}.`;
        });
      },
    });
  }
  if (verbs.has('press') || verbs.has('pressKey')) {
    tools['press_at'] = screenTool({
      description:
        'Send one key (e.g. "Enter", "Escape", "Tab") to the control at a point in the latest screenshot, for a control the screen does not list.' +
        (keyboard ? ' A listed control under the point gets the key by id; anything else is tapped to focus it and the key goes through the keyboard.' : '') +
        ' Last resort: when the screen lists the control, press by id.',
      inputSchema: z.object({ x, y, key: z.string().min(1).max(64) }),
      execute: ({ x: px, y: py, key }) => {
        const point = pointOf(px, py, 'press_at');
        if (typeof point === 'string') return Promise.resolve(point);
        return acting(`press_at ${at(px, py)}`, async () => {
          const found = await focusAt(point, px, py, 'press_at');
          if (found.kind === 'control') await context.actions.press(found.control, key);
          else await context.actions.pressKey(key);
          return `Pressed ${key} on ${found.summary}.`;
        });
      },
    });
  }
  if (verbs.has('select')) {
    tools['select_at'] = screenTool({
      description:
        'Pick one option, by its visible label, from the select-like control at a point in the latest screenshot. Last resort: when the screen lists the select, use select by id.',
      inputSchema: z.object({ x, y, value: z.string().min(1) }),
      execute: ({ x: px, y: py, value }) => {
        const point = pointOf(px, py, 'select_at');
        if (typeof point === 'string') return Promise.resolve(point);
        return acting(`select_at ${at(px, py)}`, async () => {
          const hit = await controlAt(point, 'select_at');
          await context.actions.select(hit.control, value);
          return `Selected "${value}" in ${hit.summary}.`;
        });
      },
    });
  }
  return tools;
}

/**
 * What every verb runs through: the loop guard, the
 * step's presenter, one queue for the tool bodies (an action and its look
 * at the result run together, so a batched turn gets one coherent result
 * per action), and the two moves each verb makes: present the screen after
 * an action, and perform an action then present. A failed action still
 * returns the screen, so the model can act on a stale-id or not-found
 * failure at once instead of spending a turn to observe; runtime hard stops
 * propagate to the guard, which ends the loop. The guard runs inside the
 * queue, so a batched call that queued behind a hard stop or a verdict is
 * skipped when its turn comes rather than acted on because it was queued in
 * time. An action may return its own lead line, for a result only it can
 * describe.
 */
function verbKit(context: StepExecutorContext, options: GrammarToolOptions) {
  const guard = options.guard ?? (<T>(body: () => Promise<T>) => body());
  const screen: ScreenPresenter = options.screen ?? new ScreenPresenter();
  const queue = new OperationQueue();
  const inOrder = <T>(body: () => Promise<T>): Promise<T> => queue.run(body);
  /** The screen after an action: the changes since the one the model holds and, once the step shows pixels, a fresh screenshot. */
  const present = async (lead: string, update: ScreenUpdate = {}): Promise<ScreenOutput> =>
    screen.present(await context.observe({ pixels: screen.showingPixels }), { lead, ...update });
  const acting = (
    description: string,
    action: () => Promise<string | void>,
    { expectChange = true, ...update }: ScreenUpdate = {},
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
        return present(lead, { expectChange, ...update });
      }),
    );
  return { guard, screen, verbs: context.target.verbs, inOrder, present, acting };
}

/** How the screen after an action reads (a change expected unless said otherwise); the lead is the action's own. */
type ScreenUpdate = Omit<ScreenUpdateOptions, 'lead'>;

/** Step handlers that report every model round trip to the harness budgets. */
export interface ModelCallTracker {
  /** Pass as `onStepStart`; marks the turn's start for its duration. */
  onStepStart(): void;
  /**
   * Pass as `onStepEnd` (or `onStepFinish`); records the turn's usage, cost,
   * reasoning, and provenance. Throws `STEP_BUDGET_EXHAUSTED` past the
   * model-call budget, which ends a raw loop the same way it ends the
   * chassis.
   */
  onStepEnd(step: Pick<StepResult<ToolSet>, 'usage' | 'providerMetadata' | 'reasoningText'>): void;
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
        ...(step.reasoningText === undefined ? {} : { reasoning: step.reasoningText }),
      });
    },
  };
}
