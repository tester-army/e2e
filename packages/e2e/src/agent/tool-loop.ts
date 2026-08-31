/**
 * The tool-loop chassis (RFC0001, layer 4): everything an AI SDK step
 * executor needs except its tool vocabulary. `createAgent` is this chassis
 * plus the web grammar toolset; a device or API executor brings different
 * tools and inherits the whole discipline unchanged:
 *
 * - the `complete_step` verdict tool and the closed blocked-code policy;
 * - hard-stop handling (budget/timeout/cancel end the loop, never the model);
 * - loop guards (repeated calls and short cycles warn, then force a verdict);
 * - the wind-down notice and forced conclusion on the final turns;
 * - model-call accounting and a step transcript for `--debug`.
 */

import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai';
import { z } from 'zod';
import { asSdkLanguageModel, type SdkLanguageModel } from '../config/agent.ts';
import { loadAiSdk, type AiSdk } from './ai-sdk.ts';
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
- When the step's goal is achieved, or you are certain it cannot be, call complete_step exactly once.
- Verify outcomes with your tools before concluding; never guess success.
- "passed" means the application behaved as the step required. "failed" means it did not. "blocked" means credentials, the environment, or test setup prevented a product verdict — blocked says nothing about the product and requires an errorCode.`;

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
  /** Between-turn history compaction; identity when omitted. */
  readonly compactMessages?: (messages: ModelMessage[]) => ModelMessage[];
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
      stopWhen: [
        () => this.verdict !== undefined || this.hardStop !== undefined,
        this.ai.stepCountIs(this.maxTurns),
      ],
      prepareStep: ({ messages, stepNumber }) => this.prepareTurn(messages, stepNumber),
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
          this.recordTurn(step);
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
   * Per-turn policy, in order: compact history, evaluate the loop guards,
   * inject the wind-down notice, and — near the budget or after a guard stop —
   * offer only the conclusion tool. Two forced turns, not one, so a rejected
   * verdict (blocked without a code) can be repaired.
   */
  private prepareTurn(
    messages: ModelMessage[],
    stepNumber: number,
  ): {
    messages?: ModelMessage[];
    activeTools?: string[];
    toolChoice?: { type: 'tool'; toolName: string };
  } {
    let prepared = this.options.compactMessages?.(messages) ?? messages;
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
      execute: async (input): Promise<string> => {
        if (this.verdict !== undefined) return 'The step already concluded.';
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
        this.verdict = {
          status: input.status,
          summary: input.summary,
          // A passed verdict never carries a code; a redundant one from the
          // model is dropped rather than failing the step.
          ...(input.errorCode === undefined || input.status === 'passed'
            ? {}
            : { errorCode: input.errorCode }),
        };
        return 'Step concluded.';
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
