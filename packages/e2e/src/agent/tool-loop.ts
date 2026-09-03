/**
 * The tool-loop chassis (RFC0001, layer 4): everything an AI SDK step
 * executor needs except its tool vocabulary. A project's executor is this
 * chassis plus its own toolset and prompt; a device or API executor brings
 * different tools and inherits the whole discipline unchanged:
 *
 * - the `complete_step` verdict tool and the closed blocked-code policy;
 * - hard-stop handling (budget/timeout/cancel end the loop, never the model);
 * - loop guards (repeated calls and short cycles warn, then force a verdict);
 * - the wind-down notice and forced conclusion on the final turns;
 * - a conclusion batched with other calls is discarded, never trusted;
 * - model-call accounting and a step transcript for `--debug`.
 */

import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai';
import { z } from 'zod';
import { asSdkLanguageModel, type SdkLanguageModel } from '../config/agent.ts';
import { loadAiSdk, type AiSdk } from './ai-sdk.ts';
import { readCost } from './model/sdk.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  BLOCKABLE_CODES,
  RUNTIME_CODES,
  type StepExecutor,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import { checkLoopGuards, extractGuardCalls } from './loop-guards.ts';

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
] as const;

/** The model-pickable codes a blocked verdict accepts; derived, never restated. */
const MODEL_BLOCKABLE_CODES = MODEL_ERROR_CODES.filter((code) => BLOCKABLE_CODES.has(code));

const VERDICT_RULES = `Verdict rules:
- When the step's goal is achieved, or you are certain it cannot be, call complete_step exactly once. Verify outcomes before concluding; never guess success.
- passed: the application behaved as the step required. failed: it did not. blocked: credentials, the environment, or test setup prevented a product verdict — blocked says nothing about the product and requires an errorCode.`;

/** Turns remaining when the loop warns the model to wrap up. */
const WIND_DOWN_TURNS = 5;

/**
 * Remaining step time under which the loop takes the verdict it can get. A
 * slow provider turn runs tens of seconds; concluding with the model's own
 * summary beats a verdict-less STEP_TIMEOUT every time.
 */
const CLOCK_WIND_DOWN_MS = 60_000;

/** Transcript ceiling per step; enough for every turn without unbounded logs. */
const MAX_TRANSCRIPT_CHARS = 262_144;

/** Loop services the executor's tool bodies run under. */
export interface ToolLoopHelpers {
  /**
   * Runs one string-returning tool body under loop policy: nothing executes
   * once the step is concluding, a runtime hard stop ends the loop, and every
   * other failure goes back to the model as text it can react to.
   */
  guard(body: () => Promise<string>): Promise<string>;
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
   * targets). The chassis appends the project context and the verdict rules.
   */
  readonly system?: string;
  /** Builds the step's tool vocabulary; `complete_step` is added by the chassis. */
  readonly tools: (context: StepExecutorContext, helpers: ToolLoopHelpers) => ToolSet;
  /** Builds the first user message of the step. */
  readonly buildPrompt: (context: StepExecutorContext) => string | Promise<string>;
  /** Upper bound on model turns; capped at the harness model-call budget. */
  readonly maxTurns?: number;
  /** AI SDK provider options sent with every model call (thinking level, effort). */
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Between-turn history preparation: compaction, and anything the executor
   * wants the model to read before its next turn (the default agent appends
   * what changed on screen after a turn that acted). Runs before the loop's
   * own notices; the returned history carries forward to later turns.
   */
  readonly prepareMessages?: (
    messages: ModelMessage[],
    turn: PreparedTurn,
  ) => Promise<PreparedMessages> | PreparedMessages;
}

/**
 * What `prepareMessages` hands back: the history for the next turn, and
 * optionally a reason to stop — the executor has evidence the loop guards
 * cannot see (a screen that no longer changes) that the step is not
 * progressing. A stop forces the conclusion tool exactly like a loop guard.
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
    async runStep(context: StepExecutorContext): Promise<StepVerdict> {
      // The AI SDK is an optional peer; load it before anything touches it —
      // including the context's gateway-model getter below.
      const ai = await loadAiSdk();
      const configured =
        context.model === undefined ? undefined : asSdkLanguageModel(context.model);
      const model: LanguageModel | undefined = options.model ?? configured;
      if (model === undefined) {
        throw new AgentError(
          'MODEL_UNAVAILABLE',
          `the "${options.name}" executor requires a model: set agent.model, E2E_MODEL, or pass one to the executor`,
        );
      }
      const loop = new LoopRun(ai, options, context, model);
      return loop.run();
    },
  };
}

/** One step's loop state and wiring; constructed fresh per runStep. */
class LoopRun {
  private verdict: StepVerdict | undefined;
  /**
   * A verdict the model issued this turn, promoted to `verdict` once the turn
   * ends without other tool calls beside it. A conclusion batched with actions
   * judges a screen the model has not seen; it is discarded and the model is
   * told, so a verdict always follows the evidence it claims.
   */
  private pendingVerdict: StepVerdict | undefined;
  private discardedConclusion = false;
  private hardStop: AgentError | undefined;
  private guardStop: string | undefined;
  private noticedGuardReason: string | undefined;
  private noticedLowClock = false;
  private readonly transcript: string[] = [];
  private readonly maxTurns: number;

  constructor(
    private readonly ai: AiSdk,
    private readonly options: ToolLoopExecutorOptions,
    private readonly context: StepExecutorContext,
    private readonly model: LanguageModel,
  ) {
    // Capped, never raised: the harness budget is the ceiling for any turns
    // setting, so the loop cannot spend past what the step was given.
    this.maxTurns = Math.min(
      options.maxTurns ?? context.budgets.maxModelCalls,
      context.budgets.maxModelCalls,
    );
  }

  async run(): Promise<StepVerdict> {
    const helpers = this.helpers();
    const tools: ToolSet = {
      ...this.options.tools(this.context, helpers),
      complete_step: this.concludeTool(),
    };
    const loop = new this.ai.ToolLoopAgent({
      model: this.model,
      instructions: this.instructions(),
      tools,
      toolChoice: 'required',
      // The same screen should produce the same decision run after run: a
      // test that passes fifty times in a row is the product, and sampling
      // noise is the cheapest source of a fifty-first that does not.
      temperature: 0,
      ...(this.options.providerOptions === undefined
        ? {}
        : { providerOptions: this.options.providerOptions as never }),
      stopWhen: [
        () => this.verdict !== undefined || this.hardStop !== undefined,
        this.ai.stepCountIs(this.maxTurns),
      ],
      prepareStep: ({ messages, stepNumber, steps }) =>
        this.prepareTurn(messages, stepNumber, steps.at(-1)),
    });
    const identity = this.model as { provider?: string; modelId?: string };
    const prompt = await this.options.buildPrompt(this.context);
    let turnStartedMs = Date.now();
    try {
      await loop.generate({
        prompt,
        abortSignal: this.context.signal,
        onStepStart: () => {
          turnStartedMs = Date.now();
        },
        onStepEnd: (step) => {
          this.settleConclusion(step);
          this.recordTurn(step);
          const estimatedCostUsd = readCost(step.providerMetadata);
          this.context.budgets.recordModelCall({
            ...(step.usage.inputTokens === undefined
              ? {}
              : { inputTokens: step.usage.inputTokens }),
            ...(step.usage.outputTokens === undefined
              ? {}
              : { outputTokens: step.usage.outputTokens }),
            durationMs: Date.now() - turnStartedMs,
            ...(typeof identity.provider === 'string' ? { provider: identity.provider } : {}),
            ...(typeof identity.modelId === 'string' ? { modelId: identity.modelId } : {}),
            ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
          });
        },
      });
    } catch (cause) {
      this.attachTranscript();
      if (this.context.signal.aborted) {
        throw new AgentError('CANCELLED', 'the step was cancelled', { cause });
      }
      if (this.hardStop !== undefined) throw this.hardStop;
      if (isAgentError(cause)) throw cause;
      throw new AgentError(
        'MODEL_PROVIDER_FAILED',
        `the model provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    this.attachTranscript();
    if (this.verdict !== undefined) return this.verdict;
    if (this.hardStop !== undefined) {
      if (this.hardStop.code === 'CANCELLED') throw this.hardStop;
      return { status: 'blocked', summary: this.hardStop.message, errorCode: this.hardStop.code };
    }
    return {
      status: 'failed',
      summary: `the agent used ${this.maxTurns} turn(s) without calling complete_step`,
      errorCode: 'STEP_NO_CONCLUSION',
    };
  }

  private helpers(): ToolLoopHelpers {
    return {
      concluding: () => this.verdict !== undefined || this.hardStop !== undefined,
      reportHardStop: (error) => {
        this.hardStop ??= error;
      },
      guard: async (body) => {
        if (this.verdict !== undefined || this.hardStop !== undefined) {
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
          return `Action failed: ${message}`;
        }
      },
    };
  }

  /**
   * Promotes or discards the turn's conclusion. `complete_step` alone in its
   * turn concludes; beside other calls it is dropped, because the model
   * concluded before seeing what those calls did.
   */
  private settleConclusion(step: StepResult<ToolSet>): void {
    const pending = this.pendingVerdict;
    this.pendingVerdict = undefined;
    if (pending === undefined) return;
    const others = step.toolCalls.filter((call) => call.toolName !== 'complete_step');
    if (others.length === 0) {
      this.verdict ??= pending;
      return;
    }
    this.discardedConclusion = true;
  }

  /**
   * Per-turn policy, in order: the executor's history preparation, the
   * loop guards, the wind-down notice, and — near the budget or after a guard
   * stop — only the conclusion tool. Two forced turns, not one, so a rejected
   * verdict (blocked without a code) can be repaired.
   */
  private async prepareTurn(
    messages: ModelMessage[],
    stepNumber: number,
    previous: StepResult<ToolSet> | undefined,
  ): Promise<{
    messages?: ModelMessage[];
    activeTools?: string[];
    toolChoice?: { type: 'tool'; toolName: string };
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
    if (this.discardedConclusion) {
      this.discardedConclusion = false;
      prepared = appendNotice(
        prepared,
        '[SYSTEM] Your complete_step was discarded: it was issued in the same turn as other ' +
          'tool calls, so it judged a screen you had not seen. Review the results above, then ' +
          'call complete_step on its own.',
      );
    }
    const turnsLeft = this.maxTurns - stepNumber;
    // Never on the very first turn: a deliberately short step timeout still
    // deserves one working turn before the clock takes the verdict.
    const lowClock = stepNumber > 0 && this.context.budgets.remainingMs() < CLOCK_WIND_DOWN_MS;
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
      const guard = checkLoopGuards(extractGuardCalls(prepared, 'complete_step'));
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

    const forced = turnsLeft <= 2 || this.guardStop !== undefined || lowClock;
    return {
      ...(prepared === messages ? {} : { messages: prepared }),
      ...(forced
        ? {
            activeTools: ['complete_step'],
            toolChoice: { type: 'tool' as const, toolName: 'complete_step' },
          }
        : {}),
    };
  }

  private concludeTool(): ToolSet[string] {
    const { tool } = this.ai;
    return tool({
      description:
        'Conclude the step. passed = the app behaved as required and you verified it; failed = it did not; blocked = credentials, environment, or setup prevented a verdict (requires errorCode).',
      inputSchema: z.object({
        status: z.enum(['passed', 'failed', 'blocked']),
        summary: z.string().min(1).max(500).describe('What you did and what you saw'),
        errorCode: z.enum(MODEL_ERROR_CODES).optional(),
        facts: z
          .array(z.string().min(1).max(120))
          .max(8)
          .optional()
          .describe(
            'Values a later step may need, verbatim: codes or numbers the app generated, names, totals. Omit when there are none.',
          ),
      }),
      execute: async (input): Promise<string> => {
        if (this.verdict !== undefined || this.pendingVerdict !== undefined) {
          return 'The step already concluded.';
        }
        if (
          input.status === 'blocked' &&
          (input.errorCode === undefined ||
            !MODEL_BLOCKABLE_CODES.includes(
              input.errorCode as (typeof MODEL_BLOCKABLE_CODES)[number],
            ))
        ) {
          return (
            'Rejected: a blocked verdict requires errorCode naming what blocked you ' +
            `(one of ${MODEL_BLOCKABLE_CODES.join(', ')}). ` +
            'If the application itself misbehaved, use status "failed" instead.'
          );
        }
        this.pendingVerdict = {
          status: input.status,
          summary: input.summary,
          // A passed verdict never carries a code; a redundant one from the
          // model is dropped rather than failing the step.
          ...(input.errorCode === undefined || input.status === 'passed'
            ? {}
            : { errorCode: input.errorCode }),
          ...(input.facts === undefined || input.facts.length === 0 ? {} : { facts: input.facts }),
        };
        return 'Step concluded (discarded if this turn also issued other tool calls).';
      },
    });
  }

  private instructions(): string {
    const parts: string[] = [];
    if (this.options.system !== undefined && this.options.system.trim() !== '') {
      parts.push(this.options.system);
    }
    const project = this.context.agentContext;
    if (project !== undefined && project.trim() !== '') {
      parts.push(`Project context:\n${project}`);
    }
    parts.push(VERDICT_RULES);
    return parts.join('\n\n');
  }

  /** Serializes one turn into the step transcript. */
  private recordTurn(step: StepResult<ToolSet>): void {
    const turn = this.transcript.length + 1;
    const lines: string[] = [`--- turn ${turn} ---`];
    if (step.text.trim() !== '') lines.push(`assistant: ${truncate(step.text, 1_000)}`);
    for (const call of step.toolCalls) {
      lines.push(`tool call: ${call.toolName}(${truncate(safeJson(call.input), 400)})`);
    }
    for (const result of step.toolResults) {
      lines.push(`tool result [${result.toolName}]: ${truncate(safeJson(result.output), 600)}`);
    }
    this.transcript.push(lines.join('\n'));
  }

  private attachTranscript(): void {
    if (this.transcript.length === 0) return;
    this.context.attachTranscript(truncate(this.transcript.join('\n'), MAX_TRANSCRIPT_CHARS));
  }
}

function appendNotice(messages: ModelMessage[], content: string): ModelMessage[] {
  return [...messages, { role: 'user', content }];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
