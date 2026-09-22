/**
 * The tool-loop chassis: everything an AI SDK step
 * executor needs except its tool vocabulary. `createAgent` is this chassis
 * plus the grammar toolset; a device or API executor brings different
 * tools and inherits the whole discipline unchanged:
 *
 * - the `complete_step` verdict tool and the closed blocked-code policy;
 * - hard-stop handling (budget/timeout/cancel end the loop, never the model);
 * - loop guards (repeated calls and short cycles warn, then force a verdict);
 * - the wind-down notice and forced conclusion on the final turns;
 * - model-call accounting and a step transcript for `--debug`.
 */

import type { StepTurn } from '../run/steps.ts';
import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai';
import { asSdkLanguageModel, type SdkLanguageModel } from '../config/agent.ts';
import { loadAiSdk, type AiSdk } from './ai-sdk.ts';
import { withHint } from '../internal/errors.ts';
import type { ProviderOptions } from '../types.ts';
import { credentialHint, isAbort, TRANSPORT_RETRIES } from './model/sdk.ts';
import { isContextOverflow } from './model/overflow.ts';
import { isForcedToolChoiceRejected } from './model/tool-choice.ts';
import { promptCacheHints, type CacheModelRef, type PromptCacheHints } from './model/prompt-cache.ts';
import { isScreenOutput } from './screen-update.ts';
import { compactScreenHistory } from './transcript-compaction.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  RUNTIME_CODES,
  type StepExecutor,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import { createVerdictTool, trackModelCalls, VERDICT_RULES } from './primitives.ts';
import {
  checkFailureStreak,
  checkLoopGuards,
  DEFAULT_LOOP_GUARD_THRESHOLDS,
  extractGuardCalls,
  extractToolResults,
} from './loop-guards.ts';

/** Turns remaining when the loop warns the model to wrap up, by default. */
const WIND_DOWN_TURNS = 5;

/**
 * Default ceiling on the remaining step time under which the loop takes the
 * verdict it can get. A slow provider turn runs tens of seconds; concluding
 * with the model's own summary beats a verdict-less STEP_TIMEOUT every time.
 * The effective window is a quarter of the step's budget, capped here, so a
 * short step keeps most of its clock for work instead of losing half of it to
 * the wind-down.
 */
const CLOCK_WIND_DOWN_MS = 60_000;
const CLOCK_WIND_DOWN_FRACTION = 4;

/** Turns from the budget ceiling at which only the conclusion tool is offered. */
const FORCED_CONCLUSION_TURNS = 2;

/** Transcript ceiling per step; enough for every turn without unbounded logs. */
const MAX_TRANSCRIPT_CHARS = 262_144;
/** Per-turn clips: the model's prose, one tool call's arguments, one tool result. */
const MAX_TURN_TEXT_CHARS = 1_000;
const MAX_TURN_CALL_CHARS = 400;
const MAX_TURN_RESULT_CHARS = 600;
/** The report keeps the last turns of a step, each clipped again to this. */
const MAX_REPORTED_TURNS = 12;
const MAX_REPORTED_CALLS = 8;
const MAX_REPORTED_CALL_CHARS = 200;
const MAX_REPORTED_OUTCOME_CHARS = 600;

/**
 * Models that refused a forced tool choice once. The loop asks every model
 * for a tool call on each turn; a model that answers HTTP 400 to that request
 * shape gets `auto` plus an instruction for the rest of the process, so the
 * refusal costs one round trip per model, not one per step.
 */
const FREE_TOOL_CHOICE_MODELS = new WeakSet<object>();

/** How the loop asks for tool calls: the SDK's forced modes, or `auto` for a model that rejects them. */
type ToolChoiceMode = 'required' | 'auto';

/** Appended to the instructions when the model cannot be forced to call tools. */
const TOOL_CALLS_ONLY_RULE =
  'Reply with tool calls only. A reply without a tool call does nothing and spends a turn; the step ends only through complete_step.';

/** Sent when a turn came back as text without a tool call. */
const TEXT_REPLY_NOTICE =
  '[SYSTEM] Your last reply had no tool call, so nothing happened. Continue with a tool call, or call complete_step with your verdict.';

/** Loop services the executor's tool bodies run under. */
export interface ToolLoopHelpers {
  /**
   * Runs one tool body under loop policy: nothing executes once the step is
   * concluding, a runtime hard stop ends the loop, and every other failure
   * goes back to the model as text it can react to, named by `label`.
   */
  guard<Value>(body: () => Promise<Value>, label?: string): Promise<Value | string>;
  /** True once a verdict or hard stop landed; late tool calls should no-op. */
  concluding(): boolean;
  /** Records a runtime hard stop (budget/timeout/cancel) that ends the loop. */
  reportHardStop(error: AgentError): void;
}

export interface ToolLoopExecutorOptions {
  readonly name: string;
  readonly version?: string;
  /** AI SDK language model; defaults to the config-resolved `agent.model`. */
  readonly model?: SdkLanguageModel;
  /**
   * Executor-specific system guidance (what the tools are, how to address
   * targets), fixed or built per step from its context. The chassis appends
   * the project context and the verdict rules.
   */
  readonly system?: string | ((context: StepExecutorContext) => string);
  /** Builds the step's tool vocabulary; `complete_step` is added by the chassis. */
  readonly tools: (context: StepExecutorContext, helpers: ToolLoopHelpers) => ToolSet;
  /**
   * Builds the step's opening prompt: one user message, or a whole message
   * history ending in the step's request.
   */
  readonly buildPrompt: (context: StepExecutorContext) => string | ModelMessage[] | Promise<string | ModelMessage[]>;
  /** Upper bound on model turns; capped at the harness model-call budget. */
  readonly maxTurns?: number;
  /**
   * AI SDK provider options sent with every model call (thinking level,
   * effort). Defaults to the config-resolved `agent.providerOptions`.
   */
  readonly providerOptions?: ProviderOptions;
  /**
   * Between-turn history preparation: compaction, and anything the executor
   * wants the model to read before its next turn. Runs before the loop's own
   * notices; the returned history carries forward to later turns.
   */
  readonly prepareMessages?: (
    messages: ModelMessage[],
    turn: PreparedTurn,
  ) => Promise<PreparedMessages> | PreparedMessages;
}

/**
 * What `prepareMessages` hands back: the history for the next turn, and
 * optionally a reason to stop — the executor has evidence the loop guards
 * cannot see that the step is not progressing. A stop forces the conclusion
 * tool exactly like a loop guard.
 */
export type PreparedMessages = ModelMessage[] | { readonly messages: ModelMessage[]; readonly stop?: string };

/** What an executor's `prepareMessages` learns about the turn that just ended. */
export interface PreparedTurn {
  /** Zero-based index of the turn about to run. */
  readonly stepNumber: number;
  /** Tool names the previous turn called, in order; empty on the first turn. */
  readonly previousToolCalls: readonly string[];
}

/** Builds a step executor from a tool vocabulary and the shared loop chassis. */
export function createToolLoopExecutor(options: ToolLoopExecutorOptions): StepExecutor {
  return {
    name: options.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.model === undefined ? {} : { model: options.model }),
    async runStep(context: StepExecutorContext): Promise<StepVerdict> {
      // The AI SDK is an optional peer; load it before anything touches it —
      // including the context's model getter below.
      const ai = await loadAiSdk();
      // The context's model getter resolves the configured model on read, so
      // an executor that brought its own never touches (or fails on) it.
      const model: LanguageModel | undefined =
        options.model ??
        (context.model === undefined ? undefined : asSdkLanguageModel(context.model));
      if (model === undefined) {
        throw new AgentError(
          'MODEL_UNAVAILABLE',
          `the "${options.name}" executor requires a model: pass an AI SDK model instance to createAgent({ model }) or set agent.model`,
        );
      }
      const loop = new LoopRun(ai, options, context, model);
      return loop.run();
    },
  };
}

/** One step's loop state and wiring; constructed fresh per runStep. */
class LoopRun {
  private readonly conclusion = createVerdictTool();
  private hardStop: AgentError | undefined;
  private guardStop: string | undefined;
  private noticedGuardReason: string | undefined;
  private noticedLowClock = false;
  /** Every turn that ran, oldest first: the debug transcript is rendered from it, the report keeps the tail. */
  private readonly turns: StepTurn[] = [];
  /** Loop notes from before the first turn. */
  private readonly preamble: string[] = [];
  /** Model turns that ran; `turns` mirrors it. */
  private turnsUsed = 0;
  private readonly maxTurns: number;
  /** Remaining step time under which the loop forces a verdict. */
  private readonly clockWindDownMs: number;
  /** Prompt-cache hints for the model's provider; a no-op for providers without any. */
  private readonly cache: PromptCacheHints;
  /** The history the last request went out with, for shrinking after an overflow. */
  private lastRequest: ModelMessage[] | undefined;
  /** Turns spent by earlier generate calls of this step; nonzero only after an overflow retry. */
  private turnOffset = 0;
  /**
   * Set once an overflow was handled: the retry note when the history was
   * shrunk and resent, or why it was not. A second overflow is the step's
   * verdict, and the note completes its message.
   */
  private overflowNote: string | undefined;
  /** How this step asks for tool calls; flips to `auto` when the model rejects a forced choice. */
  private toolChoice: ToolChoiceMode;
  /** The last turn that ran, for continuing after a reply without tool calls. */
  private lastStep: StepResult<ToolSet> | undefined;

  constructor(
    private readonly ai: AiSdk,
    private readonly options: ToolLoopExecutorOptions,
    private readonly context: StepExecutorContext,
    private readonly model: LanguageModel,
  ) {
    this.toolChoice = typeof model === 'object' && FREE_TOOL_CHOICE_MODELS.has(model) ? 'auto' : 'required';
    this.cache = promptCacheHints(model as CacheModelRef);
    // Capped, never raised: the harness budget is the ceiling for any turns
    // setting, so the loop cannot spend past what the step was given.
    this.maxTurns = Math.min(
      options.maxTurns ?? context.budgets.maxModelCalls,
      context.budgets.maxModelCalls,
    );
    this.clockWindDownMs = Math.min(
      CLOCK_WIND_DOWN_MS,
      Math.floor(context.budgets.remainingMs() / CLOCK_WIND_DOWN_FRACTION),
    );
  }

  async run(): Promise<StepVerdict> {
    const helpers = this.helpers();
    const tools: ToolSet = {
      ...this.options.tools(this.context, helpers),
      complete_step: this.conclusion.tool,
    };
    const tracker = trackModelCalls(
      this.context,
      this.model as { provider?: string; modelId?: string },
    );
    let prompt = await this.options.buildPrompt(this.context);
    for (;;) {
      // Built per attempt: the instructions and the tool-choice mode can
      // change between a refused request and its retry.
      const loop = this.buildLoop(tools);
      try {
        const result = await loop.generate({
          prompt,
          abortSignal: this.context.signal,
          // The whole loop, retries included, ends with the step's clock; the
          // judgment adapter bounds its calls the same way.
          timeout: Math.max(1, this.context.budgets.remainingMs()),
          onStepStart: tracker.onStepStart,
          onStepEnd: (step) => {
            this.lastStep = step;
            this.recordTurn(step);
            tracker.onStepEnd(step);
          },
        });
        const continued = this.continueAfterTextReply(result.responseMessages);
        if (continued !== undefined) {
          prompt = continued;
          continue;
        }
        break;
      } catch (cause) {
        const shrunk = this.overflowRetry(cause);
        if (shrunk !== undefined) {
          prompt = shrunk;
          continue;
        }
        const freed = this.freeToolChoiceRetry(cause);
        if (freed !== undefined) {
          prompt = freed;
          continue;
        }
        this.attachTranscript();
        if (this.context.signal.aborted) {
          throw new AgentError('CANCELLED', 'the step was cancelled', { cause });
        }
        if (this.hardStop !== undefined) throw this.hardStop;
        if (isAgentError(cause)) throw cause;
        if (isAbort(cause)) {
          throw new AgentError('STEP_TIMEOUT', 'model call exceeded the remaining step timeout', { cause });
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        if (isContextOverflow(cause)) {
          throw new AgentError(
            'CONTEXT_OVERFLOW',
            `the model request exceeded the context window${this.overflowNote ?? ''}: ${message}`,
            { cause },
          );
        }
        throw new AgentError(
          'MODEL_PROVIDER_FAILED',
          withHint(`the model provider failed: ${message}`, credentialHint(cause)),
          { cause },
        );
      }
    }
    this.attachTranscript();
    const verdict = this.conclusion.verdict();
    if (verdict !== undefined) return verdict;
    if (this.hardStop !== undefined) {
      if (this.hardStop.code === 'CANCELLED') throw this.hardStop;
      return { status: 'blocked', summary: this.hardStop.message, errorCode: this.hardStop.code };
    }
    return {
      status: 'failed',
      summary: `the agent used ${this.turnsUsed} of ${this.maxTurns} turn(s) without calling complete_step`,
      errorCode: 'STEP_NO_CONCLUSION',
    };
  }

  private buildLoop(tools: ToolSet) {
    const system = this.instructions();
    const providerOptions = this.cache.providerOptions(
      this.options.providerOptions ?? this.context.providerOptions,
      system,
    );
    return new this.ai.ToolLoopAgent({
      model: this.model,
      instructions: this.cache.instructions(system),
      tools,
      toolChoice: this.toolChoice,
      ...(providerOptions === undefined ? {} : { providerOptions: providerOptions as never }),
      maxRetries: TRANSPORT_RETRIES,
      stopWhen: [
        () => this.conclusion.concluded() || this.hardStop !== undefined,
        // Counted across every generate call of the step, so a retry after an
        // overflow continues the same turn budget rather than starting a new one.
        ({ steps }) => this.turnOffset + steps.length >= this.maxTurns,
      ],
      prepareStep: ({ messages, stepNumber, steps }) =>
        this.prepareTurn(messages, this.turnOffset + stepNumber, steps.at(-1)),
    });
  }

  /**
   * A generate call that returned without a verdict and without a hard stop
   * ended on a turn that made no tool call: the SDK loop stops when there is
   * nothing to execute. Under `required` that cannot happen; under `auto` the
   * model may answer in prose. While turns remain, the reply is kept in the
   * history and the model is told to act, on the same turn budget.
   */
  private continueAfterTextReply(responseMessages: readonly ModelMessage[]): ModelMessage[] | undefined {
    if (this.conclusion.concluded() || this.hardStop !== undefined || this.context.signal.aborted) return undefined;
    if (this.turnsUsed >= this.maxTurns || this.lastRequest === undefined) return undefined;
    if (this.lastStep === undefined || this.lastStep.toolCalls.length > 0) return undefined;
    this.turnOffset = this.turnsUsed;
    this.note(`turn ${String(this.turnsUsed)} made no tool call: asking for one`);
    const reply = responseMessages.at(-1);
    return [
      ...this.lastRequest,
      ...(reply !== undefined && reply.role === 'assistant' ? [reply] : []),
      { role: 'user', content: TEXT_REPLY_NOTICE },
    ];
  }

  /**
   * A model that refuses a forced tool choice (HTTP 400 naming
   * `tool_choice`) is asked again with `auto` and a tool-calls-only rule in
   * its instructions, on the same turn budget. The refusal is remembered per
   * model instance, so later steps start in that mode.
   */
  private freeToolChoiceRetry(cause: unknown): ModelMessage[] | undefined {
    if (this.toolChoice === 'auto' || this.lastRequest === undefined) return undefined;
    if (this.context.signal.aborted || this.hardStop !== undefined || !isForcedToolChoiceRejected(cause)) {
      return undefined;
    }
    this.toolChoice = 'auto';
    if (typeof this.model === 'object') FREE_TOOL_CHOICE_MODELS.add(this.model);
    this.turnOffset = this.turnsUsed;
    this.note(`the model rejected a forced tool choice before turn ${String(this.turnsUsed + 1)}: retrying with auto`);
    return this.lastRequest;
  }

  /**
   * The one recovery the loop attempts on its own: a request the provider
   * refused as too large is sent again with the history shrunk — superseded
   * screens elided, long texts cut — on the same turn budget. Anything else,
   * a second overflow included, is left to the caller's error translation.
   */
  private overflowRetry(cause: unknown): ModelMessage[] | undefined {
    if (this.overflowNote !== undefined || this.lastRequest === undefined) return undefined;
    if (this.context.signal.aborted || this.hardStop !== undefined || !isContextOverflow(cause)) return undefined;
    const before = textChars(this.lastRequest);
    const shrunk = shrinkForOverflow(this.lastRequest);
    const after = textChars(shrunk);
    // Nothing to elide and nothing to clip: the system prompt, the tool
    // definitions, or the sheer number of messages is what does not fit, and
    // sending the same request again would only spend another call on it.
    if (after >= before) {
      this.overflowNote = ' and the step history had nothing left to shrink';
      this.note(`context overflow before turn ${String(this.turnsUsed + 1)}: nothing to shrink`);
      return undefined;
    }
    this.overflowNote = ' again after the history was shrunk once';
    this.turnOffset = this.turnsUsed;
    this.note(`context overflow before turn ${String(this.turnsUsed + 1)}: history shrunk from ${String(before)} to ${String(after)} chars, retrying once`);
    return shrunk;
  }

  private helpers(): ToolLoopHelpers {
    return {
      concluding: () => this.conclusion.concluded() || this.hardStop !== undefined,
      reportHardStop: (error) => {
        this.hardStop ??= error;
      },
      guard: async (body, label = 'Action') => {
        if (this.conclusion.concluded() || this.hardStop !== undefined) {
          return 'The step is already concluding; no further actions run.';
        }
        try {
          return await body();
        } catch (cause) {
          if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) {
            this.hardStop ??= cause;
            return `HARD STOP (${cause.code}): ${cause.message}`;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          return `${label} failed: ${message}`;
        }
      },
    };
  }

  /**
   * Per-turn policy, in order: the executor's history preparation, the loop guards,
   * inject the wind-down notice, and — near the budget or after a guard stop —
   * offer only the conclusion tool. Two forced turns, not one, so a rejected
   * verdict (blocked without a code) can be repaired.
   */
  private async prepareTurn(
    messages: ModelMessage[],
    stepNumber: number,
    previous: StepResult<ToolSet> | undefined,
  ): Promise<{
    messages?: ModelMessage[];
    activeTools?: string[];
    toolChoice?: ToolChoiceMode | { type: 'tool'; toolName: string };
  }> {
    let prepared = messages;
    if (this.options.prepareMessages !== undefined) {
      const result = await this.options.prepareMessages(messages, {
        stepNumber,
        previousToolCalls: previous?.toolCalls.map((call) => call.toolName) ?? [],
      });
      if (Array.isArray(result)) {
        prepared = result;
      } else {
        prepared = result.messages;
        if (result.stop !== undefined && this.guardStop === undefined) this.guardStop = result.stop;
      }
    }
    const turnsLeft = this.maxTurns - stepNumber;
    // Never on the very first turn: a deliberately short step timeout still
    // deserves one working turn before the clock takes the verdict.
    const lowClock = stepNumber > 0 && this.context.budgets.remainingMs() < this.clockWindDownMs;
    if (lowClock && this.noticedLowClock !== true) {
      this.noticedLowClock = true;
      prepared = appendNotice(
        prepared,
        '[SYSTEM] The step is nearly out of time. Call complete_step now with your best ' +
          'verdict: passed only if you verified the goal, failed if the application ' +
          'misbehaved, blocked (with errorCode) if something outside the application ' +
          'stopped you.',
      );
    }

    if (this.guardStop === undefined) {
      const guard = checkLoopGuards(
        extractGuardCalls(prepared, 'complete_step'),
        DEFAULT_LOOP_GUARD_THRESHOLDS,
      );
      if (guard.kind === 'stop') {
        this.guardStop = guard.reason;
      } else if (guard.kind === 'warn' && guard.reason !== this.noticedGuardReason) {
        this.noticedGuardReason = guard.reason;
        prepared = appendNotice(
          prepared,
          `[SYSTEM NOTICE] You appear to be going in circles: ${guard.reason}. ` +
            'Change approach, or call complete_step with your best verdict.',
        );
      }
    }
    // A streak of failures with varied inputs is the same circle by another
    // route: the approach is not working, whatever id it tries next.
    if (this.guardStop === undefined) {
      const streak = checkFailureStreak(
        extractToolResults(prepared, 'complete_step'),
        DEFAULT_LOOP_GUARD_THRESHOLDS,
      );
      if (streak.kind === 'stop') {
        this.guardStop = streak.reason;
      } else if (streak.kind === 'warn' && streak.reason !== this.noticedGuardReason) {
        this.noticedGuardReason = streak.reason;
        prepared = appendNotice(
          prepared,
          `[SYSTEM NOTICE] ${streak.reason}. Read the failure text and the current screen and change approach; ` +
            'if the step cannot be done, call complete_step with your best verdict.',
        );
      }
    }
    if (this.guardStop !== undefined && this.guardStop !== this.noticedGuardReason) {
      this.noticedGuardReason = this.guardStop;
      prepared = appendNotice(
        prepared,
        `[SYSTEM] Loop guard: ${this.guardStop}. Repeating it further will not make progress. ` +
          'Call complete_step now with your best verdict: failed if the application misbehaved, ' +
          'blocked (with errorCode) if something outside the application stopped you.',
      );
    }
    if (turnsLeft === WIND_DOWN_TURNS && this.guardStop === undefined) {
      prepared = appendNotice(
        prepared,
        `[SYSTEM NOTICE] Only ${turnsLeft} turns remain for this step. ` +
          'Finish the remaining work now, or call complete_step with your best verdict: ' +
          'failed if the application misbehaved, blocked (with errorCode) if something ' +
          'outside the application stopped you.',
      );
    }

    const forced = turnsLeft <= FORCED_CONCLUSION_TURNS || this.guardStop !== undefined || lowClock;
    // The cache breakpoint rides on the newest message, whatever the turn
    // added; the history the SDK carries forward keeps it there until the
    // next turn moves it again.
    const outgoing = this.cache.markLatest(prepared);
    this.lastRequest = outgoing;
    // A model that rejects forced choices is offered the conclusion tool
    // alone under `auto`; the notices above already tell it to call it.
    return {
      ...(outgoing === messages ? {} : { messages: outgoing }),
      ...(forced
        ? {
            activeTools: ['complete_step'],
            toolChoice:
              this.toolChoice === 'required' ? { type: 'tool' as const, toolName: 'complete_step' } : 'auto',
          }
        : { toolChoice: this.toolChoice }),
    };
  }

  private instructions(): string {
    const parts: string[] = [];
    const system =
      typeof this.options.system === 'function' ? this.options.system(this.context) : this.options.system;
    if (system !== undefined && system.trim() !== '') {
      parts.push(system);
    }
    const project = this.context.agentContext;
    if (project !== undefined && project.trim() !== '') {
      parts.push(`Project context:\n${project}`);
    }
    parts.push(this.toolChoice === 'auto' ? `${VERDICT_RULES}\n- ${TOOL_CALLS_ONLY_RULE}` : VERDICT_RULES);
    return parts.join('\n\n');
  }

  /**
   * Records one turn: what the model said and called, and what came back,
   * each clipped. A call the SDK refused before dispatch (a tool the step
   * does not offer, an input outside its closed schema) never ran and has no
   * result; the turn shows its error instead, rendered as the model read it.
   */
  private recordTurn(step: StepResult<ToolSet>): void {
    this.turnsUsed += 1;
    const text = step.text.trim();
    this.turns.push({
      index: this.turnsUsed,
      calls: step.toolCalls.map((call) => `${call.toolName}(${truncate(safeJson(call.input), MAX_TURN_CALL_CHARS)})`),
      outcome: [
        ...(text === '' ? [] : [`assistant: ${truncate(text, MAX_TURN_TEXT_CHARS)}`]),
        ...step.content.flatMap((part) => {
          if (part.type === 'tool-result') return [`[${part.toolName}] ${truncate(describeOutput(part.output), MAX_TURN_RESULT_CHARS)}`];
          if (part.type === 'tool-error') return [`[${part.toolName}] error: ${truncate(String(part.error), MAX_TURN_RESULT_CHARS)}`];
          return [];
        }),
      ].join('\n'),
    });
  }

  /**
   * A loop event between turns (a reply without a tool call, an overflow
   * retry) is written onto the turn it followed, so the report and the
   * transcript both show it where it happened; before the first turn it opens
   * the record.
   */
  private note(text: string): void {
    const last = this.turns.at(-1);
    if (last === undefined) {
      this.preamble.push(`[loop] ${text}`);
      return;
    }
    last.outcome = `${last.outcome}\n[loop] ${text}`;
  }

  /** Hands the step its turns: the tail for the report, and every turn as the debug transcript. */
  private attachTranscript(): void {
    if (this.turns.length === 0 && this.preamble.length === 0) return;
    this.context.attachTurns(
      this.turns.slice(-MAX_REPORTED_TURNS).map((turn) => ({
        index: turn.index,
        calls: turn.calls.slice(0, MAX_REPORTED_CALLS).map((call) => truncate(call, MAX_REPORTED_CALL_CHARS)),
        outcome: truncate(turn.outcome, MAX_REPORTED_OUTCOME_CHARS),
      })),
    );
    const transcript = [
      ...this.preamble,
      ...this.turns.map((turn) => [`--- turn ${turn.index} ---`, ...turn.calls.map((call) => `tool call: ${call}`), turn.outcome].join('\n')),
    ];
    this.context.attachTranscript(truncate(transcript.join('\n'), MAX_TRANSCRIPT_CHARS));
  }
}

function appendNotice(messages: ModelMessage[], content: string): ModelMessage[] {
  return [...messages, { role: 'user', content }];
}

/** Longest text a message part keeps after an overflow; the head of a screen still names its controls. */
const OVERFLOW_TEXT_CLIP_CHARS = 16_384;

/**
 * Shrinks a history the provider refused as too large: every superseded full
 * screen is elided regardless of the cache-friendly budget, then any text
 * part still longer than the clip is cut to its head with a notice, so the
 * model knows to observe again for what it no longer sees.
 */
function shrinkForOverflow(messages: ModelMessage[]): ModelMessage[] {
  return compactScreenHistory(messages, { keepStaleBytes: 0 }).map((message) => {
    if (message.role === 'user') {
      if (typeof message.content === 'string') return { ...message, content: clip(message.content) };
      return {
        ...message,
        content: message.content.map((part) => (part.type === 'text' ? { ...part, text: clip(part.text) } : part)),
      };
    }
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'text') return part;
        return { ...part, output: { type: 'text' as const, value: clip(part.output.value) } };
      }),
    };
  });
}

function clip(text: string): string {
  if (text.length <= OVERFLOW_TEXT_CLIP_CHARS) return text;
  const cut = text.length - OVERFLOW_TEXT_CLIP_CHARS;
  return `${text.slice(0, OVERFLOW_TEXT_CLIP_CHARS)}\n[${String(cut)} more characters cut: the request exceeded the model's context window; observe again for what is missing]`;
}

/** Characters of text a history carries, for the transcript's account of a shrink. */
function textChars(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') total += part.text.length;
      else if (part.type === 'tool-result' && part.output.type === 'text') total += part.output.value.length;
    }
  }
  return total;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/** A tool result for the transcript: a screenshot-carrying result reads as its text plus the image size, never the bytes. */
function describeOutput(output: unknown): string {
  if (isScreenOutput(output)) return `${output.text}\n[screenshot, ${String(output.pixels.data.byteLength)} bytes]`;
  return safeJson(output);
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
