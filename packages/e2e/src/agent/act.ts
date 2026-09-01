/**
 * Harness-owned dispatch of one `agent.act()` step (RFC0001, layer 3).
 *
 * The harness opens the step, owns the deadline, the action budget, origin
 * policy, observation redaction, and recording — then hands the step to the
 * configured executor and maps its verdict back onto the runner's error
 * taxonomy. The executor never touches the backend: everything bottoms out in
 * the context built here, on the same accounting core (phases.ts) the
 * locate/judgment tier runs on. Trace-cache participation — replay, live
 * recording, staging — lives beside the dispatch in `StepTraceSession`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackendError, type SemanticNode } from '../backend/surface.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import type { Deadline } from '../internal/time.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import type { StepMetrics, StepModelInfo } from '../run/steps.ts';
import type {
  AgentErrorCode,
  AgentOptions,
  AgentParams,
  AgentResult,
  JsonValue,
  ModelInstance,
  ScrollDirection,
  Secret,
} from '../types.ts';
import { AgentError, CATEGORY_BY_CODE, isAgentError, toAgentError } from './error.ts';
import {
  rejectUnsupportedActOptions,
  validateInstruction,
  validateParams,
  validateVerdict,
} from './act-validation.ts';
import { resolveBoundedBudget, resolveTimeout } from './call-options.ts';
import {
  RUNTIME_CODES,
  type ExecutorActions,
  type ExecutorModelCall,
  type ExecutorObservation,
  type ExecutorTarget,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import type { AgentContext } from './invocation.ts';
import { serializeLedger } from './ledger.ts';
import { instantiateLanguageModel } from './model/sdk.ts';
import {
  observationShape,
  prepareObservation,
  settleObservation,
  type AgentObservation,
} from './observation.ts';
import { checkStepClock, instrumentPhase, retryingObserve } from './phases.ts';
import { authorizeSecretFill } from './secrets.ts';
import { summarizeAction, type RecordableAction } from '../cache/recorder.ts';
import { StepTraceSession, type StepCacheHost } from './step-cache.ts';

/** Everything one dispatched step is, resolved before the step opens. */
interface DispatchSpec {
  readonly api: 'agent.act' | 'agent.assert';
  readonly kind: 'act' | 'assert';
  readonly instruction: string;
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
  /** Secrets declared in the params, by stable name. */
  readonly secrets: ReadonlyMap<string, Secret>;
  /** The code a code-less non-passing verdict maps to. */
  readonly defaultFailureCode: AgentErrorCode;
  readonly timeout: number | undefined;
  readonly maxSteps: number | undefined;
  readonly maxModelCalls: number | undefined;
}

/** Runs one `agent.act()` call as a harness-dispatched executor step. */
export async function runActStep(
  runtime: AgentContext,
  instruction: string,
  params: AgentParams | undefined,
  options: AgentOptions | undefined,
): Promise<AgentResult> {
  const normalized = validateInstruction(instruction, 'agent.act');
  rejectUnsupportedActOptions(options);
  const { projected, secrets } = validateParams(params);
  await dispatchAgentStep(runtime, {
    api: 'agent.act',
    kind: 'act',
    instruction: normalized,
    params: projected,
    secrets,
    defaultFailureCode: 'ACTION_FAILED',
    timeout: options?.timeout,
    maxSteps: options?.maxSteps,
    maxModelCalls: options?.maxModelCalls,
  });
  return { ok: true };
}

/**
 * Runs one `agent.assert()` call through the executor socket. Used when a
 * custom executor is configured: the brain that plans flows also judges
 * assertions, so swapping brains swaps all the thinking. The built-in
 * single-judgment tier remains the default-path implementation.
 */
export async function runAssertStep(
  runtime: AgentContext,
  assertion: string,
  options: { timeout?: number; vision?: unknown; screenshot?: boolean } | undefined,
): Promise<void> {
  const normalized = validateInstruction(assertion, 'agent.assert');
  const unsupported = (name: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `agent.assert ${name} is not supported with a custom executor`,
    );
  };
  if (options?.vision !== undefined) unsupported('vision evidence (options.vision)');
  if (options?.screenshot !== undefined) unsupported('screenshot evidence (options.screenshot)');
  await dispatchAgentStep(runtime, {
    api: 'agent.assert',
    kind: 'assert',
    instruction: normalized,
    params: undefined,
    secrets: new Map(),
    defaultFailureCode: 'ASSERTION_FAILED',
    timeout: options?.timeout,
    maxSteps: undefined,
    maxModelCalls: undefined,
  });
}

/**
 * Opens the step, tries a cached replay, delegates to the executor when the
 * cache misses or diverges, settles the verdict, and — on a pass in
 * read-write mode — stages the step's action trace for attempt-end
 * settlement. A step that settles non-passed after consuming a cached replay
 * evicts that entry, so a poisoned flow re-records instead of replaying
 * forever; cancellation evicts nothing, exactly like an interrupted attempt.
 */
async function dispatchAgentStep(runtime: AgentContext, spec: DispatchSpec): Promise<void> {
  await runtime.steps.run('agent', spec.api, spec.instruction, async () => {
    const dispatch = new ActDispatch(runtime, spec);
    try {
      try {
        let verdict: StepVerdict;
        try {
          verdict = await dispatch.run();
        } catch (cause) {
          throw dispatch.settleThrown(toAgentError(cause));
        }
        dispatch.settle(validateVerdict(verdict, runtime.executor.name));
        await dispatch.stageTrace();
      } catch (cause) {
        if (!(isAgentError(cause) && cause.code === 'CANCELLED')) {
          await dispatch.evictConsumedReplay();
        }
        throw cause;
      }
    } finally {
      dispatch.finish();
    }
  });
}

/**
 * One step's harness-side state: budgets, the newest observation, and the
 * fatal error (if any) that must outrank whatever the executor reports.
 */
class ActDispatch {
  private readonly timeoutMs: number;
  private readonly deadline: Deadline;
  private readonly maxActions: number;
  private readonly maxModelCalls: number;
  private readonly metrics: StepMetrics = {
    modelCalls: 0,
    actionSteps: 0,
    observationBytes: 0,
    contextBytes: 0,
    ledgerBytes: 0,
  };
  private latest: AgentObservation | undefined;
  private explanation: string | undefined;
  /** First budget/timeout/cancel failure; runtime truth outranks the verdict. */
  private hardStop: AgentError | undefined;
  /** Aborts the executor on any hard stop, so a step never outlives its clock. */
  private readonly stepAbort = new AbortController();
  /**
   * Serializes observations and actions in call order. An executor (or an AI
   * SDK loop running parallel tool calls) that issues a second action before
   * the first settles would otherwise resolve both targets against the same
   * pre-action observation — exactly the wrong-node hazard the staleness rule
   * exists to prevent. Queued, the second call sees the newest observation
   * and a stale id fails loud instead of acting on the wrong node.
   *
   * Invariant: a serialized body must never call `observe()` or `runAction()`
   * itself — the inner call would queue behind its own caller and deadlock.
   * Grammar bodies call the session directly, and secret authorization
   * never observes; keep it that way.
   */
  private grammarChain: Promise<unknown> = Promise.resolve();
  private sdkModel: ModelInstance | undefined;
  private sdkModelResolved = false;
  private transcript: string | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private estimatedCostUsd: number | undefined;
  private peakTokensPerCall = 0;
  private providerReportedUsage = false;
  private modelProvider: string | undefined;
  private modelId: string | undefined;
  private readonly redact: (text: string) => string;
  /** The step's trace-cache session; undefined when caching is off or the kind is not cacheable. */
  private readonly stepCache: StepTraceSession | undefined;

  constructor(
    private readonly runtime: AgentContext,
    private readonly spec: DispatchSpec,
  ) {
    this.timeoutMs = resolveTimeout(spec.timeout, runtime.config.timeout);
    this.deadline = runtime.engine.deadline(this.timeoutMs);
    this.maxActions = resolveBoundedBudget(
      spec.maxSteps,
      runtime.config.agent.maxSteps,
      'maxSteps',
    );
    this.maxModelCalls = resolveBoundedBudget(
      spec.maxModelCalls,
      runtime.config.agent.maxModelCalls,
      'maxModelCalls',
    );
    this.metrics.contextBytes = new TextEncoder().encode(runtime.agentContext ?? '').byteLength;
    this.redact = runtime.redact;
    // Only act steps are cacheable: an assert must not change state, so its
    // trace would be empty — nothing to replay, nothing worth a read. The
    // dispatch always runs inside a recorded step; a missing index would mean
    // that invariant broke, and withholding the whole session is the safe
    // answer.
    const cache = spec.kind === 'act' ? runtime.cache : undefined;
    const stepIndex = runtime.steps.currentStepIndex;
    this.stepCache =
      cache === undefined || stepIndex === undefined
        ? undefined
        : new StepTraceSession({
            cache,
            instruction: spec.instruction,
            params: spec.params,
            executor: {
              name: runtime.executor.name,
              ...(runtime.executor.version === undefined
                ? {}
                : { version: runtime.executor.version }),
            },
            redact: this.redact,
            testIdAttribute: runtime.config.testIdAttribute,
            maxActions: this.maxActions,
            stepIndex,
          });
  }

  /** Builds the executor-facing context. */
  context(): StepExecutorContext {
    // The `model` getter below runs with the context object as `this`.
    // oxlint-disable-next-line typescript/no-this-alias
    const dispatch = this;
    const ledger = serializeLedger(
      this.runtime.priorSteps(),
      this.runtime.config.limits.maxLedgerBytes,
    );
    this.metrics.ledgerBytes = ledger.bytes;
    const replayedPrefix = this.stepCache?.replayedPrefix;
    return {
      step: {
        kind: this.spec.kind,
        instruction: this.spec.instruction,
        params: this.spec.params,
        secrets: [...this.spec.secrets.values()].map((secret) => ({
          name: secret.name,
          purpose: secret.purpose,
        })),
      },
      target: this.runtime.target,
      ...(replayedPrefix === undefined ? {} : { replayedPrefix }),
      signal: AbortSignal.any([this.runtime.signal, this.stepAbort.signal]),
      // Resolved on first read, so executors that bring their own model (or
      // none) never pay for — or fail on — config model resolution.
      get model() {
        return dispatch.resolveModel();
      },
      ledger: ledger.text,
      agentContext: this.runtime.agentContext,
      budgets: {
        maxActions: this.maxActions,
        maxModelCalls: this.maxModelCalls,
        actionsUsed: () => this.metrics.actionSteps,
        remainingMs: () => this.deadline.remaining(),
        recordModelCall: (usage) => this.recordModelCall(usage),
        recordToolCall: (call) => this.recordToolCall(call),
      },
      observe: () => this.observe(),
      attachTranscript: (text) => {
        // Debug detail only: transcripts are model prose and can be large.
        if (this.runtime.debug?.enabled === true && typeof text === 'string' && text !== '') {
          this.transcript = text;
        }
      },
      actions: this.buildActions(),
    };
  }

  /**
   * The action grammar, shared verbatim by the executor context and the
   * replay engine: a replayed action runs under exactly the same deadline,
   * budget, policy, and recording as a live one. Committed actions are
   * recorded into the step trace with the node they actually acted on —
   * capture at commit time is what makes the descriptor durable evidence
   * rather than a guess.
   */
  private buildActions(): ExecutorActions {
    return {
      tap: (target) =>
        this.commitTargeted('tap', target, async (node) => {
          await this.session.perform(node.ref, { kind: 'tap' }, this.operation());
          return { name: 'tap', node };
        }),
      type: (target, value) => {
        if (typeof value !== 'string') {
          throw new TestError('INVALID_ARGUMENT', 'type value must be a string');
        }
        return this.commitTargeted('type', target, async (node) => {
          await this.session.perform(
            node.ref,
            { kind: 'fill', value, sensitive: false },
            this.operation(),
          );
          return { name: 'type', node, value };
        });
      },
      typeSecret: (target, name) => this.typeSecret(target, name),
      press: (target, key) => {
        if (typeof key !== 'string' || key.trim() === '' || key.length > 64) {
          throw new TestError('INVALID_ARGUMENT', 'press key must be a short non-empty string');
        }
        return this.commitTargeted('press', target, async (node) => {
          await this.session.perform(node.ref, { kind: 'press', key }, this.operation());
          return { name: 'press', node, key };
        });
      },
      select: (target, value) => {
        if (typeof value !== 'string' || value === '') {
          throw new TestError('INVALID_ARGUMENT', 'select value must be a non-empty option label');
        }
        return this.commitTargeted('selectOption', target, async (node) => {
          await this.session.perform(node.ref, { kind: 'selectOption', value }, this.operation());
          return { name: 'select', node, value };
        });
      },
      scroll: (direction, target) => this.scroll(direction, target),
      navigate: (url) => this.navigate(url),
    };
  }

  /**
   * Races the step body — cached replay first, then the executor on a miss or
   * divergence — against the step deadline. An executor that ignores every
   * context call still cannot outlive the clock: the timer records the
   * timeout as the hard stop, aborts the step signal, and settles the step —
   * the promise is abandoned, never awaited past the deadline.
   */
  async run(): Promise<StepVerdict> {
    const timer = setTimeout(() => {
      this.fatalize(
        new AgentError('STEP_TIMEOUT', `${this.spec.api} exceeded its ${this.timeoutMs} ms timeout`),
      );
    }, Math.max(1, this.deadline.remaining()));
    try {
      return await Promise.race([
        this.dispatchStep(),
        new Promise<never>((_, reject) => {
          const signal = this.stepAbort.signal;
          if (signal.aborted) {
            reject(signal.reason as Error);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchStep(): Promise<StepVerdict> {
    if (this.stepCache !== undefined) {
      const replayed = await this.stepCache.tryReplay(this.replayHost());
      if (replayed !== undefined) return replayed;
    }
    return this.runtime.executor.runStep(this.context());
  }

  /** The replay engine's narrow view of this dispatch. */
  private replayHost(): StepCacheHost {
    return {
      observeNodes: async () => (await this.observeLatest()).nodes,
      latestShape: () => (this.latest === undefined ? undefined : observationShape(this.latest)),
      actions: this.buildActions(),
      signal: AbortSignal.any([this.runtime.signal, this.stepAbort.signal]),
      remainingMs: () => this.deadline.remaining(),
      redact: this.redact,
      testIdAttribute: this.runtime.config.testIdAttribute,
      currentPath: () => this.currentPath(),
    };
  }

  /** Best-effort current location path + query, for trace preconditions. */
  private async currentPath(): Promise<string | undefined> {
    const currentUrl = this.session.url;
    if (currentUrl === undefined) return undefined;
    try {
      const url = new URL(await currentUrl(this.operation()));
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }

  /** Stages the step's recorded trace for attempt-end settlement. */
  async stageTrace(): Promise<void> {
    if (this.stepCache === undefined || !this.stepCache.wantsStage) return;
    // The end path is the trace's postcondition; captured only when a write
    // can actually happen, so read-only runs pay no extra backend call.
    this.stepCache.stage(this.explanation, await this.currentPath());
  }

  /** Evicts a consumed replay entry after a non-passed settle. */
  async evictConsumedReplay(): Promise<void> {
    await this.stepCache?.evictOnFailure();
  }

  /** Maps the executor's verdict onto the runner outcome. Fail-closed on hard stops. */
  settle(verdict: StepVerdict): void {
    let settled = verdict;
    if (this.hardStop !== undefined) {
      if (this.hardStop.code === 'CANCELLED') throw this.hardStop;
      if (settled.status === 'passed') {
        // The step ran out of budget or time mid-flight; an executor cannot
        // declare success over the runtime's own accounting.
        settled = {
          status: 'blocked',
          summary: this.hardStop.message,
          errorCode: this.hardStop.code,
        };
      } else if (settled.errorCode === undefined) {
        // The executor's analysis stands, but runtime exhaustion is never
        // hidden from the report: a code-less failure inherits the hard stop.
        settled = { ...settled, errorCode: this.hardStop.code };
      }
    }
    if (
      settled.errorCode !== undefined &&
      RUNTIME_CODES.has(settled.errorCode) &&
      !this.vouches(settled.errorCode)
    ) {
      throw this.invented(settled.errorCode);
    }
    this.explanation = settled.summary;
    if (settled.status === 'passed') return;
    const code =
      settled.errorCode !== undefined && settled.errorCode in CATEGORY_BY_CODE
        ? settled.errorCode
        : this.spec.defaultFailureCode;
    throw new AgentError(code, `${this.spec.api} ${settled.status}: ${settled.summary}`, {
      blocked: settled.status === 'blocked',
    });
  }

  /**
   * Classifies an executor throw. The recorded hard stop wins over any
   * derived failure, and a runtime code the runtime cannot corroborate is an
   * invalid verdict, not a runtime failure.
   */
  settleThrown(error: AgentError): AgentError {
    if (!RUNTIME_CODES.has(error.code)) return error;
    if (this.hardStop !== undefined) return this.hardStop;
    if (this.vouches(error.code)) return error;
    return this.invented(error.code, error);
  }

  /**
   * Whether the runtime's own accounting corroborates a runtime code. Codes
   * are runtime-assigned: the recorded hard stop vouches directly, and the
   * clock, the budgets, and the abort signal vouch for an executor that
   * observed exhaustion before the context machinery did.
   */
  private vouches(code: AgentErrorCode): boolean {
    if (this.hardStop?.code === code) return true;
    switch (code) {
      case 'CANCELLED':
        return this.runtime.signal.aborted;
      case 'STEP_TIMEOUT':
        return this.deadline.expired();
      case 'STEP_BUDGET_EXHAUSTED':
        return (
          this.metrics.actionSteps >= this.maxActions ||
          this.metrics.modelCalls >= this.maxModelCalls
        );
      default:
        return false;
    }
  }

  private invented(code: AgentErrorCode, cause?: AgentError): AgentError {
    return new AgentError(
      'MODEL_OUTPUT_INVALID',
      `executor "${this.runtime.executor.name}" reported runtime code ${code}, which the runtime never assigned`,
      cause === undefined ? {} : { cause },
    );
  }

  /**
   * Records the first hard stop. Timeout and cancellation also abort the step
   * signal — there is nothing left for the executor to say. Budget exhaustion
   * does not: the executor may still catch it and conclude with its own
   * analysis (which `settle` stamps with the runtime code), bounded by the
   * deadline either way.
   */
  private fatalize(error: AgentError): AgentError {
    this.hardStop ??= error;
    if (error.code !== 'STEP_BUDGET_EXHAUSTED' && !this.stepAbort.signal.aborted) {
      this.stepAbort.abort(this.hardStop);
    }
    return error;
  }

  /**
   * Counts and accounts one executor-made model call. The budget is enforced:
   * the call past the limit records, then hard-stops the step.
   */
  private recordModelCall(usage: ExecutorModelCall | undefined): void {
    this.metrics.modelCalls += 1;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
      this.providerReportedUsage = true;
      this.inputTokens += inputTokens;
      this.outputTokens += outputTokens;
      this.peakTokensPerCall = Math.max(this.peakTokensPerCall, inputTokens + outputTokens);
    }
    if (usage?.provider !== undefined) this.modelProvider = usage.provider;
    if (usage?.modelId !== undefined) this.modelId = usage.modelId;
    // Executors are trusted, but the report schema requires a finite,
    // non-negative cost; a bogus value must not invalidate the whole report.
    if (
      usage?.estimatedCostUsd !== undefined &&
      Number.isFinite(usage.estimatedCostUsd) &&
      usage.estimatedCostUsd >= 0
    ) {
      this.estimatedCostUsd = (this.estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
    }
    this.runtime.steps.recordEvent({
      kind: 'model',
      startedAt: timestamp(),
      durationMs: Math.max(0, Math.round(usage?.durationMs ?? 0)),
      status: 'passed',
      name: 'executor',
      count: inputTokens + outputTokens,
    });
    this.runtime.debug?.record('agent.model', Math.max(0, Math.round(usage?.durationMs ?? 0)));
    if (this.metrics.modelCalls > this.maxModelCalls) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `${this.spec.api} exhausted its model-call budget of ${this.maxModelCalls}`,
        ),
      );
    }
  }

  /**
   * Records one executor tool call that bypassed the grammar. Mutating tools
   * consume an action-budget slot, so a project tool cannot spend past the
   * ceiling the grammar enforces.
   */
  private recordToolCall(call: { name: string; mutates: boolean; durationMs?: number }): void {
    this.checkpoint();
    this.runtime.steps.recordEvent({
      kind: 'backend',
      startedAt: timestamp(),
      durationMs: Math.max(0, Math.round(call.durationMs ?? 0)),
      status: 'passed',
      name: `tool:${call.name}`,
    });
    if (!call.mutates) return;
    this.metrics.actionSteps += 1;
    // A project-tool mutation is a gap: the grammar cannot reproduce it, so a
    // replay of this step's trace ends here rather than skipping the change.
    this.stepCache?.recordGap(call.name);
    if (this.metrics.actionSteps > this.maxActions) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `${this.spec.api} exhausted its action budget of ${this.maxActions}`,
        ),
      );
    }
  }

  /** Attaches metrics, model provenance, and the verdict explanation to the step. */
  finish(): void {
    const cacheInfo = this.stepCache?.cacheInfo;
    this.runtime.steps.attachAgentDetails({
      metrics: { ...this.metrics },
      ...(this.metrics.modelCalls > 0 ? { model: this.modelInfo() } : {}),
      ...(cacheInfo === undefined ? {} : { cache: cacheInfo }),
      ...(this.explanation !== undefined ? { explanation: this.explanation } : {}),
      ...(this.latest !== undefined ? { observationRevision: this.latest.revision } : {}),
    });
    this.writeTranscript();
  }

  /** Persists the executor transcript as a step-attributed `log` artifact. */
  private writeTranscript(): void {
    if (this.transcript === undefined) return;
    const stepId = this.runtime.steps.currentStepId ?? 'act';
    const name = `transcript-${stepId.replace(/[^A-Za-z0-9_-]+/g, '-')}.txt`;
    try {
      writeFileSync(join(this.runtime.artifacts.dir, name), this.transcript, 'utf8');
      this.runtime.steps.attachArtifact(this.runtime.artifacts.register('log', name));
    } catch {
      // The transcript is best-effort debug detail; never fail the step for it.
    }
  }

  /**
   * Model provenance for the report. The executor is the authority on which
   * model answered; an executor that reports nothing is still identified, so a
   * step's model calls are never attributed to the wrong tier.
   */
  private modelInfo(): StepModelInfo {
    const executor = this.runtime.executor;
    const executorVersion = executor.version ?? '0';
    return {
      provider: this.modelProvider ?? executor.name,
      model: this.modelId ?? executor.name,
      endpoint: 'provider-default',
      adapterVersion: `executor/${executor.name}@${executorVersion}`,
      policyVersion: `${executor.name}/${executorVersion}`,
      calls: this.metrics.modelCalls,
      tokenAccounting: this.providerReportedUsage ? 'provider' : 'adapter-upper-bound',
      peakTokensPerCall: this.peakTokensPerCall,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: this.estimatedCostUsd }),
    };
  }

  private get session() {
    return this.runtime.engine.session;
  }

  /**
   * One backend operation's budget: `actionTimeout`, capped by the step clock.
   * Bounding each call independently is what keeps a single screen that never
   * settles from consuming the whole step — the hang costs one action
   * timeout and a clearly attributed failure, not the test budget.
   */
  private operation() {
    return this.runtime.engine.operation(
      Math.max(1, Math.min(this.runtime.config.actionTimeout, this.deadline.remaining())),
    );
  }

  /** Resolves the configured model once; executors that never read it never pay. */
  private resolveModel(): ModelInstance | undefined {
    if (!this.sdkModelResolved) {
      const resolved = this.runtime.config.agent.model;
      this.sdkModel = resolved === undefined ? undefined : instantiateLanguageModel(resolved);
      this.sdkModelResolved = true;
    }
    return this.sdkModel;
  }

  /** Fails when the step is cancelled or out of time; records the hard stop. */
  private checkpoint(cause?: unknown): void {
    try {
      checkStepClock({
        signal: this.runtime.signal,
        deadline: this.deadline,
        api: this.spec.api,
        timeoutMs: this.timeoutMs,
        ...(cause === undefined ? {} : { cause }),
      });
    } catch (error) {
      if (isAgentError(error)) this.fatalize(error);
      throw error;
    }
  }

  /** Chains one grammar operation behind every earlier one, in call order. */
  private serialized<T>(body: () => Promise<T>): Promise<T> {
    // The chain is always already settled-to-undefined, so failures propagate
    // to their own caller and never poison the queue.
    const run = this.grammarChain.then(body);
    this.grammarChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The executor-facing observe: always settled. An executor observation is
   * followed by a model call measured in seconds, so the bounded settle wait
   * is noise there — and it guarantees the model never reads a snapshot the
   * app is still reacting to, which a fast model turns into a repeated action
   * (double-committing a toggle) and a verdict judged on pre-render state.
   * Replay reads raw (`observeLatest`) and settles on its own schedule.
   */
  private async observe(): Promise<ExecutorObservation> {
    const observation = await this.serialized(() => this.observeNow(true));
    return {
      revision: observation.revision,
      text: observation.text,
      truncated: observation.truncated,
      viewport: observation.viewport,
    };
  }

  private observeLatest(): Promise<AgentObservation> {
    return this.serialized(() => this.observeNow(false));
  }

  /** One recorded observation; when `settle`, the captures loop inside it. */
  private async observeNow(settle: boolean): Promise<AgentObservation> {
    this.checkpoint();
    const observation = await instrumentPhase(
      this.runtime,
      { api: this.spec.api, kind: 'observation', phase: 'agent.observe' },
      () =>
        settle
          ? settleObservation(() => this.captureObservation(), observationShape, {
              remainingMs: () => this.deadline.remaining(),
              // The step's own hard stop must interrupt a settle sleep too —
              // the attempt signal alone would let settling outlive the step
              // by one poll interval.
              signal: AbortSignal.any([this.runtime.signal, this.stepAbort.signal]),
            })
          : this.captureObservation(),
      (prepared) => ({ count: prepared.nodes.size, bytes: prepared.bytes }),
    );
    this.latest = observation;
    this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
    return observation;
  }

  /** One raw observation capture: retried at the backend, then redacted and bounded. */
  private async captureObservation(): Promise<AgentObservation> {
    const raw = await retryingObserve({
      observe: (operation) => this.session.observe(operation, { pixels: false }),
      operation: () => this.operation(),
      guard: (cause) => this.checkpoint(cause),
      signal: this.runtime.signal,
      api: this.spec.api,
    });
    return prepareObservation(raw, {
      redact: this.runtime.redact,
      maxBytes: this.runtime.config.agent.maxObservationBytes,
      testIdAttribute: this.runtime.config.testIdAttribute,
    });
  }

  /** Resolves an executor target against the newest observation. */
  private resolveTarget(target: ExecutorTarget): SemanticNode {
    if (typeof target?.id !== 'string' || target.id === '') {
      throw new TestError('INVALID_ARGUMENT', 'action target must be { id: string }');
    }
    const id = target.id.replace(/^#/, '');
    const latest = this.latest;
    if (latest === undefined) {
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        'no observation has been captured yet; observe before acting',
      );
    }
    const node = latest.nodes.get(id);
    if (node === undefined) {
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        `node #${id} is not part of observation ${latest.revision}; re-observe and use a current id`,
      );
    }
    return node;
  }

  /**
   * Runs one grammar action against the action budget, recorded as a backend
   * event. The body performs the backend call and returns the committed
   * action's recordable descriptor — one value carries both concerns: the
   * event's `detail` prose derives from it in a pure hook, and the dispatch
   * writes it to the trace cache after the phase settles.
   */
  private runAction(name: string, body: () => Promise<RecordableAction>): Promise<void> {
    return this.serialized(() => this.runActionNow(name, body));
  }

  private async runActionNow(name: string, body: () => Promise<RecordableAction>): Promise<void> {
    this.checkpoint();
    if (this.metrics.actionSteps >= this.maxActions) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `${this.spec.api} exhausted its action budget of ${this.maxActions}`,
        ),
      );
    }
    // The budget slot is consumed either way: a failed dispatch was an attempt.
    this.metrics.actionSteps += 1;
    let action: RecordableAction;
    try {
      action = await instrumentPhase(
        this.runtime,
        { api: this.spec.api, kind: 'backend', phase: 'agent.action', name },
        body,
        (committed) => ({
          detail: summarizeAction(committed, this.redact, this.runtime.config.testIdAttribute),
        }),
      );
    } catch (cause) {
      this.checkpoint(cause);
      throw cause;
    }
    this.stepCache?.record(action);
  }

  /** One action against a resolved node; a stale ref asks for a re-observe. */
  private commitTargeted(
    name: string,
    target: ExecutorTarget,
    perform: (node: SemanticNode) => Promise<RecordableAction>,
  ): Promise<void> {
    return this.runAction(name, async () => {
      const node = this.resolveTarget(target);
      try {
        return await perform(node);
      } catch (cause) {
        if (cause instanceof BackendError && cause.code === 'NODE_STALE') {
          throw new AgentError(
            'LOCATOR_NOT_FOUND',
            'the target node is stale; re-observe and use a current id',
            { cause },
          );
        }
        throw cause;
      }
    });
  }

  private async scroll(direction: ScrollDirection, target: ExecutorTarget | undefined): Promise<void> {
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new TestError('INVALID_ARGUMENT', `invalid scroll direction "${String(direction)}"`);
    }
    if (target === undefined) {
      await this.runAction('scroll', async () => {
        await this.session.swipe(direction, undefined, this.operation());
        return { name: 'scroll', direction };
      });
      return;
    }
    await this.commitTargeted('scroll', target, async (node) => {
      await this.session.perform(node.ref, { kind: 'swipe', direction }, this.operation());
      return { name: 'scroll', direction, node };
    });
  }

  /**
   * Fills one declared secret. The name must come from the step's own params
   * — an executor can never fill a credential the test did not hand it — and
   * the fill itself runs the full secret authorization policy: registered credential, origin allowlists, and an editable sink
   * whose purpose matches. Pixel evidence is tainted from here on.
   */
  private async typeSecret(target: ExecutorTarget, name: string): Promise<void> {
    const secret = this.spec.secrets.get(name);
    if (secret === undefined) {
      throw new AgentError(
        'POLICY_DENIED',
        `secret "${name}" was not declared in this step's params; only declared secrets can be filled`,
      );
    }
    await this.commitTargeted('typeSecret', target, async (node) => {
      const plaintext = await authorizeSecretFill(
        {
          session: this.session,
          operation: () => this.operation(),
          recordPolicy: (policy, decision, code) => this.recordPolicy(policy, decision, code),
        },
        this.runtime,
        secret,
        node,
      );
      await this.session.perform(
        node.ref,
        { kind: 'fill', value: plaintext, sensitive: true },
        this.operation(),
      );
      this.runtime.taint.value = true;
      // Recorded by stable name only; replay re-runs the full authorization.
      return { name: 'typeSecret', node, secret: name };
    });
  }

  /** Records one policy decision as a child event, mirroring the locate tier. */
  private recordPolicy(name: string, decision: 'allowed' | 'denied', code?: string): void {
    this.runtime.steps.recordEvent({
      kind: 'policy',
      startedAt: timestamp(),
      durationMs: 0,
      status: decision === 'allowed' ? 'passed' : 'failed',
      name,
      decision,
      ...(code === undefined ? {} : { code }),
    });
  }

  private async navigate(url: string): Promise<void> {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TestError('INVALID_ARGUMENT', 'navigate requires a URL');
    }
    const resolved = resolveNavigationUrl(
      url,
      this.runtime.config.app.base,
      this.runtime.config.app.allowedOrigins,
    ).url;
    // The raw argument is recorded, not the resolved URL: replay re-resolves
    // through the same base and origin policy this call just passed.
    await this.runAction('navigate', async () => {
      await this.session.app.open(resolved, this.operation());
      return { name: 'navigate', url };
    });
  }
}
