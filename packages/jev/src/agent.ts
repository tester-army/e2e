/**
 * A step executor whose brain is an evaluation model.
 *
 * Jev (TypeSafe AI, `typesafe-ai/jev` on the AI Gateway) does not generate
 * text. It reads a state and answers typed questions in one parallel pass:
 * a choice with a probability per option, a boolean with a probability. That
 * is exactly the shape of an act turn once the vocabulary is enumerated: is
 * the step done, which verb, which node, which literal. One round trip per
 * turn, a few hundred milliseconds, priced on input tokens alone.
 *
 * What the model cannot do, the executor arranges around it. Node ids come
 * from the observation, never from the model. Typed text comes from the
 * literals the step spells out; a value the step leaves open goes to an
 * optional generative fallback, one short completion. A screen with more
 * nodes than a choice can hold is chosen in two levels. A repeated action
 * with no visible effect is seen by the executor, not hoped against.
 *
 * Assertions are one boolean question against the screen.
 */

import { experimental_evaluate as evaluate, type LanguageModel } from 'ai';
import type { StepExecutor, StepExecutorContext, StepVerdict } from 'e2e';
import { isAgentError } from 'e2e/agent';
import { acceptsText, candidatesOf, diffShapes, isSecure, pagesOf, scrollTargetsOf, shapeOf, type Candidate, type ScreenDiff } from './screen.ts';
import { generateValue, literalsOf } from './values.ts';

export interface JevAgentOptions {
  /** Gateway model id of the evaluation model. Defaults to `typesafe-ai/jev`. */
  readonly model?: string;
  /**
   * A generative model that writes the one value a step leaves open ("a todo
   * of your choice"). Without it such a step fails with a reason.
   */
  readonly fallback?: LanguageModel;
  /** Turns per act step before the executor gives up. Defaults to 15. */
  readonly maxTurns?: number;
  /** Probability of `done` that ends an act step as passed. Defaults to 0.6. */
  readonly doneThreshold?: number;
  /** Probability of an assertion holding that passes it; one minus it fails it. Defaults to 0.7. */
  readonly assertThreshold?: number;
}

/** Jev's list price on the gateway: input tokens only, output free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** A choice question holds at most this many options. */
const MAX_OPTIONS = 255;

/** Candidates per page when the screen needs a two-level pick. */
const PAGE_SIZE = 200;

/** How long one `wait` turn pauses before the next look. */
const WAIT_MS = 1_500;

/** Pauses before re-observing a screen that looks unchanged after an action. */
const QUIET_SCREEN_RECHECKS_MS = [400, 400, 400] as const;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

type Turn = Parameters<StepExecutorContext['attachTurns']>[0][number];
type ModelCall = NonNullable<Parameters<StepExecutorContext['budgets']['recordModelCall']>[0]>;

type Verb = 'tap' | 'type' | 'press_enter' | 'select' | 'scroll_down' | 'scroll_up' | 'wait' | 'fail';

const VERB_TEXT: Record<Verb, string> = {
  tap: 'click or tap the target: a button, link, checkbox, radio, tab, menu item, option. Every element listed on the screen can be tapped directly, even one far below the fold: the harness scrolls it into view',
  type: 'type a text value into the target text field; this does not submit the field',
  press_enter: 'press Enter in the target text field to submit what it already holds',
  select: 'choose a value in the target dropdown (combobox)',
  scroll_down: 'scroll down to load or reveal content that is NOT listed on the screen yet (a lazy feed, a windowed table); never to reach an element that is already listed',
  scroll_up: 'scroll the page up; no target',
  wait: 'the page is still loading, a spinner or placeholder is showing, or a result is about to appear: wait a moment and look again without acting',
  fail: 'nothing on this screen can progress the step: the flow is impossible here',
};

interface EvaluateAnswers {
  readonly [key: string]:
    | { readonly type?: string; readonly probability: number }
    | { readonly type?: string; readonly choice: string; readonly probabilities?: Record<string, number> };
}

function chosen(answers: EvaluateAnswers, key: string): { choice: string; p: number } {
  const answer = answers[key];
  if (answer === undefined || !('choice' in answer)) throw new Error(`Jev returned no choice for ${key}`);
  return { choice: answer.choice, p: answer.probabilities?.[answer.choice] ?? 0 };
}

function probability(answers: EvaluateAnswers, key: string): number {
  const answer = answers[key];
  if (answer === undefined || !('probability' in answer)) throw new Error(`Jev returned no probability for ${key}`);
  return answer.probability;
}

/** A step executor driven by Jev: `agents: { default: { executor: jevAgent({ fallback }) } }`. */
export function jevAgent(options: JevAgentOptions = {}): StepExecutor {
  const modelId = options.model ?? 'typesafe-ai/jev';
  const maxTurns = options.maxTurns ?? 15;
  const doneThreshold = options.doneThreshold ?? 0.6;
  const assertThreshold = options.assertThreshold ?? 0.7;

  async function ask(
    context: StepExecutorContext,
    state: unknown,
    questions: Record<string, unknown>,
  ): Promise<EvaluateAnswers> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = await evaluate({
      model: modelId,
      state: state as string,
      questions: questions as never,
      abortSignal: context.signal,
    });
    const inputTokens = result.usage?.inputTokens;
    const call: ModelCall = {
      startedAt,
      durationMs: Math.round(performance.now() - started),
      provider: 'typesafe-ai',
      modelId: modelId.replace(/^typesafe-ai\//, ''),
      ...(inputTokens === undefined ? {} : { inputTokens, estimatedCostUsd: inputTokens * USD_PER_INPUT_TOKEN }),
      ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
    };
    context.budgets.recordModelCall(call);
    return result.answers as EvaluateAnswers;
  }

  async function runAssert(context: StepExecutorContext): Promise<StepVerdict> {
    const observation = await context.observe();
    const answers = await ask(
      context,
      {
        task: 'You are judging one assertion about the current screen of an application under test.',
        assertion: context.step.instruction,
        ...(context.step.params === undefined ? {} : { parameters: context.step.params }),
        ...(context.agentContext === undefined ? {} : { context: context.agentContext }),
        ...(context.ledger === '' ? {} : { previousSteps: context.ledger }),
        screen: { path: observation.path, nodes: observation.text.split('\n') },
      },
      {
        holds: {
          type: 'boolean',
          instructions: 'Does the current screen satisfy the assertion?',
          criteria: {
            true: 'the screen shows the asserted state',
            false: 'the screen contradicts the assertion, or does not show what it asserts',
          },
        },
      },
    );
    const p = probability(answers, 'holds');
    const shown = `p(holds)=${p.toFixed(2)}`;
    context.attachTurns([{ index: 1, calls: [`evaluate(holds)`], outcome: shown }]);
    if (p >= assertThreshold) return { status: 'passed', summary: `the assertion holds (${shown})` };
    if (p <= 1 - assertThreshold) {
      return { status: 'failed', summary: `the assertion does not hold (${shown})`, errorCode: 'ASSERTION_FAILED' };
    }
    return {
      status: 'failed',
      summary: `the screen does not settle the assertion (${shown})`,
      errorCode: 'ASSERTION_INCONCLUSIVE',
    };
  }

  async function runAct(context: StepExecutorContext): Promise<StepVerdict> {
    const { step, target } = context;
    const verbs: Verb[] = ['wait', 'fail'];
    if (target.verbs.has('tap')) verbs.unshift('tap');
    if (target.verbs.has('type')) verbs.unshift('type');
    if (target.verbs.has('press')) verbs.unshift('press_enter');
    if (target.verbs.has('select')) verbs.unshift('select');
    if (target.verbs.has('scroll')) verbs.unshift('scroll_down', 'scroll_up');

    const literals = literalsOf(step.instruction, step.params);
    const history: string[] = [];
    const turns: Turn[] = [];
    if (context.replayedPrefix !== undefined) {
      history.push(...context.replayedPrefix.replayedActions.map((action) => `already done by replay: ${action}`));
    }
    let lastShape: string | undefined;
    let lastAction: string | undefined;
    let lastTarget: Candidate | undefined;
    let lastVerb: Verb | undefined;
    let repeats = 0;
    let effect: ScreenDiff | 'no visible change' | undefined;
    /** The node the last no-effect tap hit; withheld from the next turn's choice so the step moves on. */
    let withheld: Candidate | undefined;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (context.signal.aborted) break;
      let observation = await context.observe();
      let shape = shapeOf(observation.text);
      if (lastShape !== undefined && lastAction !== undefined) {
        // A quiet screen right after an action is rechecked before it is
        // called unchanged: late fetch effects land within a second or so.
        for (const delay of QUIET_SCREEN_RECHECKS_MS) {
          if (shape !== lastShape || context.signal.aborted) break;
          await pause(delay, context.signal);
          observation = await context.observe();
          shape = shapeOf(observation.text);
        }
        effect = shape === lastShape ? 'no visible change' : diffShapes(lastShape, shape);
        // A secret fill leaves the tree as it was: the field hides its value.
        // The history already says the field is filled; it is not a stall.
        if (shape === lastShape && lastAction.startsWith('typeSecret')) {
          effect = undefined;
        } else if (shape === lastShape) {
          history[history.length - 1] += ' -> NO visible change on the screen';
          repeats += 1;
          const tolerated = lastAction.startsWith('wait') ? 6 : lastAction.startsWith('scroll') ? 5 : 3;
          if (repeats >= tolerated) {
            context.attachTurns(turns);
            return {
              status: 'failed',
              summary: `stuck: "${lastAction}" changed nothing three times in a row`,
              errorCode: 'ACTION_FAILED',
            };
          }
        } else {
          repeats = 0;
        }
      }
      lastShape = shape;

      let candidates = candidatesOf(observation.text);
      withheld = effect === 'no visible change' && lastTarget !== undefined && lastVerb === 'tap' ? lastTarget : undefined;
      if (withheld !== undefined) candidates = candidates.filter((c) => c.id !== withheld?.id);
      const state = {
        task: 'You are a QA tester performing one test step in an application. Decide the next action. Obey the rules.',
        step: step.instruction,
        ...(step.params === undefined ? {} : { parameters: step.params }),
        ...(context.agentContext === undefined ? {} : { rules: context.agentContext }),
        ...(context.ledger === '' ? {} : { previousSteps: context.ledger }),
        history: history.length === 0 ? 'no actions taken yet in this step' : history,
        ...(withheld === undefined
          ? {}
          : { note: `${withheld.line} was just tapped and changed nothing visible; it is not offered again this turn. If that tap did what the step needed, move on to the next part of the step.` }),
        ...(effect === undefined
          ? {}
          : {
              lastActionEffect:
                effect === 'no visible change'
                  ? 'the last action changed nothing visible'
                  : { appeared: effect.added, disappeared: effect.removed },
            }),
        screen: { path: observation.path, truncated: observation.truncated, nodes: observation.text.split('\n') },
      };

      // A screen wider than one choice question: pick the page first.
      if (candidates.length > MAX_OPTIONS) {
        const pages = pagesOf(candidates, PAGE_SIZE);
        const picked = await ask(context, state, {
          page: {
            type: 'choice',
            instructions: 'Which part of the screen holds the element the tester must act on next for this step?',
            criteria: Object.fromEntries(pages.map((page, index) => [`p${index}`, page.map((c) => c.line).join('\n')])),
          },
        });
        candidates = pages[Number(chosen(picked, 'page').choice.slice(1))] ?? candidates.slice(0, PAGE_SIZE);
      }

      const questions: Record<string, unknown> = {
        done: {
          type: 'boolean',
          instructions: 'Is the step ALREADY fully accomplished on the current screen, so that no further action is needed?',
          criteria: { true: 'the screen shows the end state the step asks for', false: 'at least one more action is required' },
        },
        pending: {
          type: 'boolean',
          instructions: 'Does the step still require at least one more action before it is complete: a confirm, submit, save, or the last item of a list the step named?',
          criteria: { true: 'something the step asks for has not happened yet', false: 'everything the step asks for has visibly happened' },
        },
        action: {
          type: 'choice',
          instructions: 'Which single action should the tester perform NEXT to progress the step, given the history?',
          criteria: Object.fromEntries(verbs.map((verb) => [verb, VERB_TEXT[verb]])),
        },
      };
      if (candidates.length > 0) {
        questions['target'] = {
          type: 'choice',
          instructions: 'Which element is the target of the next action?',
          criteria: Object.fromEntries(candidates.map((c) => [c.id, c.line])),
        };
      }
      const scrollTargets = target.verbs.has('scroll') ? scrollTargetsOf(observation.text) : [];
      if (scrollTargets.length > 0) {
        questions['scrollTarget'] = {
          type: 'choice',
          instructions: 'If the next action scrolls, which region should scroll? Choose the page unless the content to reveal sits inside a scrollable region of its own.',
          criteria: { page: 'the page itself (the window)', ...Object.fromEntries(scrollTargets.map((c) => [c.id, c.line])) },
        };
      }
      if (literals.length > 1) {
        questions['value'] = {
          type: 'choice',
          instructions: 'If the next action types or selects a value, which of these values does it use?',
          criteria: Object.fromEntries(literals.map((literal, index) => [`v${index}`, literal])),
        };
      }

      const answers = await ask(context, state, questions);
      const done = probability(answers, 'done');
      const pending = probability(answers, 'pending');
      let action = chosen(answers, 'action');
      // Giving up needs a majority: a `fail` at 0.36 is a tie, not a verdict.
      // The runner-up acts instead; with none, the turn waits.
      if (action.choice === 'fail' && action.p < 0.5) {
        const answer = answers['action'];
        const ranked = Object.entries((answer !== undefined && 'probabilities' in answer && answer.probabilities) || {})
          .filter(([verb]) => verb !== 'fail')
          .toSorted((a, b) => b[1] - a[1]);
        action = ranked[0] === undefined ? { choice: 'wait', p: 0 } : { choice: ranked[0][0], p: ranked[0][1] };
      }
      const targetPick = candidates.length > 0 ? chosen(answers, 'target') : undefined;
      const candidate = candidates.find((c) => c.id === targetPick?.choice);
      const note = `done=${done.toFixed(2)} pending=${pending.toFixed(2)} ${action.choice}(${action.p.toFixed(2)})${
        candidate === undefined ? '' : ` -> ${candidate.line} (${(targetPick?.p ?? 0).toFixed(2)})`
      }`;

      // Done is gated: the step must read as complete AND nothing may read as
      // still pending. A step that looks done before any action needs to be
      // sure of it: steps whose end state is already on screen are rare.
      // And a confident, concrete next action contradicts "done": a model
      // that is 80% sure the next move is "tap Confirm" has not finished.
      const contradicted = action.choice !== 'fail' && action.choice !== 'wait' && action.p >= 0.8 && done < 0.95;
      const concluded =
        done >= doneThreshold && pending <= 1 - doneThreshold && (history.length > 0 || done >= 0.85) && !contradicted;
      if (concluded) {
        turns.push({ index: turn, calls: ['evaluate(done)'], outcome: note });
        context.attachTurns(turns);
        return {
          status: 'passed',
          summary: `Jev judged the step complete (done=${done.toFixed(2)}, pending=${pending.toFixed(2)}) after ${history.length} action(s)`,
        };
      }
      if (action.choice === 'fail') {
        turns.push({ index: turn, calls: ['evaluate(fail)'], outcome: note });
        context.attachTurns(turns);
        return {
          status: 'failed',
          summary: `Jev found no action that progresses the step (p=${action.p.toFixed(2)}); done=${done.toFixed(2)}`,
          errorCode: 'ACTION_FAILED',
        };
      }

      let performed: string;
      try {
        performed = await perform(context, action.choice as Verb, candidate, answers, literals, history, observation.text, scrollTargets);
      } catch (cause) {
        if (isAgentError(cause) && (cause.code === 'STEP_BUDGET_EXHAUSTED' || cause.code === 'STEP_TIMEOUT' || cause.code === 'CANCELLED')) {
          throw cause;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        performed = `${action.choice}${candidate === undefined ? '' : ` on ${candidate.line}`} FAILED: ${message.split('\n')[0]}`;
      }
      history.push(`turn ${turn}: ${performed}`);
      lastAction = performed;
      lastTarget = candidate;
      lastVerb = action.choice as Verb;
      turns.push({ index: turn, calls: [performed], outcome: note });
    }

    context.attachTurns(turns);
    if (context.signal.aborted) {
      return { status: 'blocked', summary: 'the step was stopped before Jev concluded', errorCode: 'STEP_TIMEOUT' };
    }
    return {
      status: 'failed',
      summary: `Jev used ${maxTurns} turn(s) without judging the step complete`,
      errorCode: 'STEP_NO_CONCLUSION',
    };
  }

  /** Executes one chosen action through the harness grammar and returns its one-line account. */
  async function perform(
    context: StepExecutorContext,
    verb: Verb,
    candidate: Candidate | undefined,
    answers: EvaluateAnswers,
    literals: readonly string[],
    history: readonly string[],
    screen: string,
    scrollTargets: readonly Candidate[],
  ): Promise<string> {
    const { actions, step } = context;
    if (verb === 'wait') {
      await pause(WAIT_MS, context.signal);
      return 'wait 1.5 s and look again';
    }
    if (verb === 'scroll_down' || verb === 'scroll_up') {
      const direction = verb === 'scroll_down' ? 'down' : 'up';
      const region = scrollTargets.length > 0 ? chosen(answers, 'scrollTarget').choice : 'page';
      const container = scrollTargets.find((c) => c.id === region);
      if (container === undefined) {
        await actions.scroll(direction);
        return `scroll ${direction} (page)`;
      }
      await actions.scroll(direction, { id: container.id });
      return `scroll ${direction} in ${container.line}`;
    }
    if (candidate === undefined) throw new Error('no interactive element on the screen to act on');
    const target = { id: candidate.id };
    if (verb === 'tap') {
      await actions.tap(target);
      return `tap ${candidate.line}`;
    }
    if (verb === 'press_enter') {
      await actions.press(target, 'Enter');
      return `press Enter on ${candidate.line}`;
    }
    // type / select need a value.
    if (verb === 'type' && isSecure(candidate) && step.secrets.length > 0) {
      const secret = step.secrets.find((s) => s.purpose === 'password') ?? step.secrets[0]!;
      await actions.typeSecret(target, secret.name);
      return `typeSecret ${secret.name} into ${candidate.line} (the field is now filled; it hides its value, so the screen will not show it)`;
    }
    let value: string | undefined;
    if (literals.length === 1) value = literals[0];
    else if (literals.length > 1) value = literals[Number(chosen(answers, 'value').choice.slice(1))];
    if (value === undefined) {
      if (options.fallback === undefined) {
        throw new Error(`the step spells out no value to ${verb}; configure jevAgent({ fallback }) to write one`);
      }
      const generated = await generateValue(
        options.fallback,
        { instruction: step.instruction, field: candidate.line, screen, history },
        context.signal,
      );
      const fallbackId = generated.modelId;
      context.budgets.recordModelCall({
        modelId: fallbackId,
        durationMs: generated.durationMs,
        ...(generated.inputTokens === undefined ? {} : { inputTokens: generated.inputTokens }),
        ...(generated.outputTokens === undefined ? {} : { outputTokens: generated.outputTokens }),
      });
      value = generated.value;
    }
    if (verb === 'select') {
      await actions.select(target, value);
      return `select ${JSON.stringify(value)} in ${candidate.line}`;
    }
    if (!acceptsText(candidate)) {
      // The model picked a non-text node for typing: tap it instead of typing into the void.
      await actions.tap(target);
      return `tap ${candidate.line} (chosen for typing, but it accepts no text)`;
    }
    await actions.type(target, value);
    return `type ${JSON.stringify(value)} into ${candidate.line}`;
  }

  return {
    name: 'jev-agent',
    version: '1',
    async runStep(context) {
      try {
        return context.step.kind === 'assert' ? await runAssert(context) : await runAct(context);
      } catch (cause) {
        if (isAgentError(cause)) {
          if (cause.code === 'CANCELLED') throw cause;
          if (cause.code === 'STEP_BUDGET_EXHAUSTED' || cause.code === 'STEP_TIMEOUT') {
            return { status: 'blocked', summary: cause.message, errorCode: cause.code };
          }
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        return { status: 'blocked', summary: `the evaluation model failed: ${message}`, errorCode: 'MODEL_PROVIDER_FAILED' };
      }
    },
  };
}
