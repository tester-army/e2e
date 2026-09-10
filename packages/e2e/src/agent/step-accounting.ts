/**
 * The clock, the budgets, and the books of one dispatched agent step.
 *
 * Everything the runtime enforces against an executor is enforced here and
 * nowhere else: the deadline and the signal that ends the step, the action
 * and model-call budgets, the metrics the report carries, and the first hard
 * stop, which outranks whatever the executor says afterwards. The observation
 * feed, the action dispatcher, and the pixel tier all borrow this object;
 * none of them keeps a count of its own.
 */

import type { OperationContext } from '../engine/surface.ts';
import { timestamp } from '../internal/ids.ts';
import type { Deadline } from '../internal/time.ts';
import type { StepMetrics, StepModelInfo } from '../run/steps.ts';
import type { AgentErrorCode } from '../types.ts';
import { AgentError, isAgentError } from './error.ts';
import type { ExecutorModelCall, StepExecutor } from './executor.ts';
import type { AgentContext } from './invocation.ts';
import type { ModelProvenance, ModelUsage as ModelCallUsage } from './model/adapter.ts';
import { boundedOperation, checkStepClock } from './phases.ts';
import { POLICY_VERSION } from './prompts.ts';
import { ModelUsage, tokenFields } from './usage.ts';

/**
 * Ceiling on one targeted grammar action: the time the engine may wait for a
 * node to become actionable before the failure goes back to the model.
 * `actionTimeout` bounds every engine operation and doubles as the judgment
 * tier's clock, so projects raise it for slow models; a tap under a consent
 * overlay then sits in the engine's actionability retry for the whole budget
 * (90 s in the testbed) before the model learns anything, when the useful
 * answer — what is in the way — is known within seconds. Navigation keeps the
 * full budget: a slow page really can take that long to load.
 */
const MAX_TARGETED_ACTION_MS = 15_000;

export interface StepAccountingOptions {
  /** Public API name of the step, e.g. `agent.act`, for every message it raises. */
  readonly api: string;
  readonly timeoutMs: number;
  readonly maxActions: number;
  readonly maxModelCalls: number;
  /** Bytes of trusted agent context every model turn resends; a fixed cost the metrics carry. */
  readonly contextBytes: number;
}

export class StepAccounting {
  readonly api: string;
  readonly timeoutMs: number;
  readonly maxActions: number;
  readonly maxModelCalls: number;
  readonly deadline: Deadline;
  /**
   * The one signal everything inside the step aborts with: the attempt's
   * cancellation or the step's own hard stop. Built once so the executor
   * context, the replay host, and the settle clock can never disagree about
   * what "the step's signal" means.
   */
  readonly signal: AbortSignal;
  readonly metrics: StepMetrics = {
    modelCalls: 0,
    actionSteps: 0,
    observationBytes: 0,
    contextBytes: 0,
    ledgerBytes: 0,
  };
  /** Usage of the executor's own model calls. */
  readonly usage = new ModelUsage();
  /** Usage of the harness-made vision calls, booked apart so the report names the model that answered. */
  private readonly visionUsage = new ModelUsage();
  private visionProvenance: ModelProvenance | undefined;
  private visionCalls = 0;
  /** Aborts the executor on any hard stop, so a step never outlives its clock. */
  private readonly stepAbort = new AbortController();
  /** First budget/timeout/cancel failure; runtime truth outranks the verdict. */
  private firstHardStop: AgentError | undefined;
  /** Set by `close()`: late executor accounting must not land on the next step. */
  private ended = false;
  private modelProvider: string | undefined;
  private modelId: string | undefined;

  constructor(
    private readonly runtime: AgentContext,
    options: StepAccountingOptions,
  ) {
    this.api = options.api;
    this.timeoutMs = options.timeoutMs;
    this.maxActions = options.maxActions;
    this.maxModelCalls = options.maxModelCalls;
    this.metrics.contextBytes = options.contextBytes;
    this.deadline = runtime.engine.deadline(options.timeoutMs);
    this.signal = AbortSignal.any([runtime.engine.signal, this.stepAbort.signal]);
  }

  get hardStop(): AgentError | undefined {
    return this.firstHardStop;
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Closes the books; anything reported afterwards belongs to no step. */
  close(): void {
    this.ended = true;
  }

  remainingMs(): number {
    return this.deadline.remaining();
  }

  /**
   * Records the first hard stop. Timeout and cancellation also abort the step
   * signal — there is nothing left for the executor to say. Budget exhaustion
   * does not: the executor may still catch it and conclude with its own
   * analysis (which the verdict mapping stamps with the runtime code), bounded
   * by the deadline either way.
   */
  fatalize(error: AgentError): AgentError {
    this.firstHardStop ??= error;
    if (error.code !== 'STEP_BUDGET_EXHAUSTED' && !this.stepAbort.signal.aborted) {
      this.stepAbort.abort(this.firstHardStop);
    }
    return error;
  }

  /** Fails when the step is cancelled or out of time; records the hard stop. */
  checkpoint(cause?: unknown): void {
    try {
      checkStepClock({
        signal: this.runtime.engine.signal,
        deadline: this.deadline,
        api: this.api,
        timeoutMs: this.timeoutMs,
        ...(cause === undefined ? {} : { cause }),
      });
    } catch (error) {
      if (isAgentError(error)) this.fatalize(error);
      throw error;
    }
  }

  /** Claims a mutation slot before any side effect, for grammar actions and project tools alike. */
  reserveAction(): void {
    this.checkpoint();
    if (this.ended) throw new AgentError('CANCELLED', 'the step has ended');
    if (this.metrics.actionSteps >= this.maxActions) {
      throw this.fatalize(
        new AgentError('STEP_BUDGET_EXHAUSTED', `${this.api} exhausted its action budget of ${this.maxActions}`),
      );
    }
    // The budget slot is consumed either way: a failed dispatch was an attempt.
    this.metrics.actionSteps += 1;
  }

  /**
   * Counts and accounts one executor-made model call. The budget is enforced:
   * the call past the limit records, then hard-stops the step.
   */
  recordModelCall(usage: ExecutorModelCall | undefined): void {
    // An executor abandoned by a hard stop can still report late; the step it
    // belonged to is closed, and the recorder's active step is now another.
    if (this.ended) return;
    const tokens = this.usage.record(usage);
    if (usage?.provider !== undefined) this.modelProvider = usage.provider;
    if (usage?.modelId !== undefined) this.modelId = usage.modelId;
    this.runtime.steps.recordEvent({
      kind: 'model',
      startedAt: usage?.startedAt ?? timestamp(),
      durationMs: Math.max(0, Math.round(usage?.durationMs ?? 0)),
      status: 'passed',
      name: 'executor',
      count: tokens,
      ...tokenFields(usage),
    });
    this.runtime.debug?.record('agent.model', Math.max(0, Math.round(usage?.durationMs ?? 0)));
    this.countModelCall();
  }

  /** Books the usage of one harness-made vision call; returns the token count for its event. */
  recordVisionUsage(usage: ModelCallUsage): number {
    return this.visionUsage.record(usage);
  }

  /**
   * Counts one harness-made vision call (the pixel tier) against the budget.
   * The call records its own phase event and usage; the ceiling is one
   * number whoever spent it, while the report keeps the vision model's calls
   * under its own name.
   */
  countVisionCall(provenance: ModelProvenance): void {
    this.visionProvenance = provenance;
    this.visionCalls += 1;
    this.countModelCall();
  }

  private countModelCall(): void {
    this.metrics.modelCalls += 1;
    if (this.metrics.modelCalls > this.maxModelCalls) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `${this.api} exhausted its model-call budget of ${this.maxModelCalls}`,
        ),
      );
    }
  }

  /** One engine operation: `actionTimeout`, capped by the step clock. */
  operation(): OperationContext {
    return boundedOperation(this.runtime.engine, this.runtime.config.actionTimeout, this.deadline);
  }

  /** The operation context of one targeted action; see MAX_TARGETED_ACTION_MS. */
  actionOperation(): OperationContext {
    return boundedOperation(
      this.runtime.engine,
      Math.min(this.runtime.config.actionTimeout, MAX_TARGETED_ACTION_MS),
      this.deadline,
    );
  }

  /**
   * Whether the runtime's own accounting corroborates a runtime code. Codes
   * are runtime-assigned: the recorded hard stop vouches directly, and the
   * clock, the budgets, and the abort signal vouch for an executor that
   * observed exhaustion before the context machinery did.
   */
  vouches(code: AgentErrorCode): boolean {
    if (this.firstHardStop?.code === code) return true;
    switch (code) {
      case 'CANCELLED':
        return this.runtime.engine.signal.aborted;
      case 'STEP_TIMEOUT':
        return this.deadline.expired();
      case 'STEP_BUDGET_EXHAUSTED':
        return this.metrics.actionSteps >= this.maxActions || this.metrics.modelCalls >= this.maxModelCalls;
      default:
        return false;
    }
  }

  /**
   * The executor's own model calls for the report, or undefined when it made
   * none. The executor is the authority on which model answered; an executor
   * that reports nothing is still identified, so a step's model calls are
   * never attributed to the wrong tier. Vision calls are reported apart
   * (`visionModelInfo`), never under the executor's model.
   */
  modelInfo(executor: Pick<StepExecutor, 'name' | 'version'>): StepModelInfo | undefined {
    const calls = this.metrics.modelCalls - this.visionCalls;
    if (calls === 0) return undefined;
    const executorVersion = executor.version ?? '0';
    return this.usage.report(
      {
        provider: this.modelProvider ?? executor.name,
        model: this.modelId ?? executor.name,
        endpoint: 'provider-default',
        adapterVersion: `executor/${executor.name}@${executorVersion}`,
        policyVersion: `${executor.name}/${executorVersion}`,
      },
      calls,
    );
  }

  /** The harness-made vision calls for the report, under the vision adapter's provenance; undefined when there were none. */
  visionModelInfo(): StepModelInfo | undefined {
    if (this.visionProvenance === undefined) return undefined;
    return this.visionUsage.report({ ...this.visionProvenance, policyVersion: POLICY_VERSION }, this.visionCalls);
  }
}
