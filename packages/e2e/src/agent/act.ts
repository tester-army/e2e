/**
 * Harness-owned dispatch of one `agent.act()` step (RFC0001, layer 3).
 *
 * The harness opens the step, owns the deadline, the action budget, origin
 * policy, observation redaction, and recording — then hands the step to the
 * configured executor and maps its verdict back onto the runner's error
 * taxonomy. The executor never touches the engine: everything bottoms out in
 * the context built here, on the same accounting core (phases.ts) the
 * locate/judgment tier runs on. Trace-cache participation — replay, live
 * recording, staging — lives beside the dispatch in `StepTraceSession`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError, type OperationContext, type SemanticNode } from '../engine/surface.ts';
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
  type ExecutorObserveOptions,
  type ExecutorTarget,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import type { AgentContext } from './invocation.ts';
import { isDerivedValue } from './derived.ts';
import { projectPriorSteps, serializeLedger } from './ledger.ts';
import { instantiateLanguageModel } from './model/sdk.ts';
import {
  observationShape,
  pixelsForModel,
  prepareObservation,
  projectTree,
  settleObservation,
  type AgentObservation,
} from './observation.ts';
import { boundedOperation, checkStepClock, instrumentPhase, recordPolicyEvent, retryingObserve } from './phases.ts';
import { containerKey, describeAction, type RecordableAction } from './actions.ts';
import { authorizeSecretFill } from './secrets.ts';
import { ModelUsage } from './usage.ts';
import { StepTraceSession, type StepCacheHost, type StepOutcome } from './step-cache.ts';

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
 * cache misses or diverges, settles the verdict, and hands the outcome to the
 * cache session, which owns the stage-or-evict decision
 * (`StepTraceSession.conclude`). An assert is a verification step: its
 * passing is what confirms the traces staged before it at attempt end
 * (cache/context.ts).
 */
async function dispatchAgentStep(runtime: AgentContext, spec: DispatchSpec): Promise<void> {
  await runtime.steps.run('agent', spec.api, spec.instruction, async () => {
    const dispatch = new ActDispatch(runtime, spec);
    try {
      let verdict: StepVerdict;
      try {
        verdict = await dispatch.run();
      } catch (cause) {
        throw dispatch.settleThrown(toAgentError(cause));
      }
      dispatch.settle(validateVerdict(verdict, runtime.executor.name));
      await dispatch.conclude('passed');
    } catch (cause) {
      await dispatch.conclude(isAgentError(cause) && cause.code === 'CANCELLED' ? 'cancelled' : 'failed');
      throw cause;
    } finally {
      dispatch.finish();
    }
  }, { verifies: spec.kind === 'assert' });
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
   * The one signal everything inside the step aborts with: the attempt's
   * cancellation or the step's own hard stop. Built once in the constructor
   * so the executor context, the replay host, and the settle clock can never
   * disagree about what "the step's signal" means.
   */
  private readonly stepSignal: AbortSignal;
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
  /** Set by `finish()`: late executor accounting must not land on the next step. */
  private closed = false;
  private readonly usage = new ModelUsage();
  private modelProvider: string | undefined;
  private modelId: string | undefined;
  private readonly redact: (text: string) => string;
  /** The step's trace-cache session; undefined when caching is off or the kind is not cacheable. */
  private readonly stepCache: StepTraceSession | undefined;
  /** Timeline index of the step being dispatched. */
  private readonly stepIndex: number;
  /** The last pixel decision recorded on this step: `allowed`, or the withheld reason. */
  private pixelsDecided: string | undefined;

  constructor(
    private readonly runtime: AgentContext,
    private readonly spec: DispatchSpec,
  ) {
    this.stepSignal = AbortSignal.any([runtime.engine.signal, this.stepAbort.signal]);
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
    // The dispatch always runs inside a recorded step (`dispatchAct` opens
    // one); the index names the step to the executor and to the trace cache.
    const stepIndex = runtime.steps.currentStepIndex;
    if (stepIndex === undefined) throw new Error('agent step dispatched outside a recorded step');
    this.stepIndex = stepIndex;
    // Only act steps are cacheable: an assert must not change state, so its
    // trace would be empty — nothing to replay, nothing worth a read. An
    // executor that declared `cache: 'off'` sees every step itself.
    const cache =
      spec.kind === 'act' && runtime.executor.cache !== 'off' ? runtime.cache : undefined;
    this.stepCache =
      cache === undefined
        ? undefined
        : new StepTraceSession(this.cacheHost(), {
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
      projectPriorSteps(this.runtime.priorSteps()),
      this.runtime.config.limits.maxLedgerBytes,
    );
    this.metrics.ledgerBytes = ledger.bytes;
    const replayedPrefix = this.stepCache?.replayedPrefix;
    return {
      step: {
        kind: this.spec.kind,
        index: this.stepIndex,
        instruction: this.spec.instruction,
        params: this.spec.params,
        secrets: [...this.spec.secrets.values()].map((secret) => ({
          name: secret.name,
          purpose: secret.purpose,
        })),
      },
      target: this.runtime.target,
      attempt: this.runtime.attempt,
      ...(replayedPrefix === undefined ? {} : { replayedPrefix }),
      signal: this.stepSignal,
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
        runTool: (call, body) => this.runTool(call, body),
      },
      observe: (options) => this.observe(options),
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
    const replayed = await this.stepCache?.begin();
    if (replayed !== undefined) return replayed;
    return this.runtime.executor.runStep(this.context());
  }

  /** The cache session's narrow view of this dispatch. */
  private cacheHost(): StepCacheHost {
    return {
      observe: async () => (await this.observeLatest()).nodes,
      observeSettled: async () => (await this.observeSettled()).nodes,
      actions: this.buildActions(),
      signal: this.stepSignal,
      remainingMs: () => this.deadline.remaining(),
      redact: this.redact,
      testIdAttribute: this.runtime.config.testIdAttribute,
      currentPath: (nodes) => this.currentPath(nodes !== undefined && nodes === this.latest?.nodes ? this.latest : undefined),
    };
  }

  /** Best-effort current location path + query, for trace preconditions. */
  private async currentPath(observation?: AgentObservation): Promise<string | undefined> {
    const currentUrl = this.session.url;
    if (observation?.url === undefined && currentUrl === undefined) return undefined;
    try {
      const url = new URL(observation?.url ?? await currentUrl!(this.operation()));
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }

  /** Hands the settled outcome to the cache session, which stages, evicts, or does nothing. */
  async conclude(outcome: StepOutcome): Promise<void> {
    await this.stepCache?.conclude(outcome, this.explanation);
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
        return this.runtime.engine.signal.aborted;
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
    // An executor abandoned by a hard stop can still report late; the step it
    // belonged to is closed, and the recorder's active step is now another.
    if (this.closed) return;
    this.metrics.modelCalls += 1;
    const tokens = this.usage.record(usage);
    if (usage?.provider !== undefined) this.modelProvider = usage.provider;
    if (usage?.modelId !== undefined) this.modelId = usage.modelId;
    this.runtime.steps.recordEvent({
      kind: 'model',
      startedAt: timestamp(),
      durationMs: Math.max(0, Math.round(usage?.durationMs ?? 0)),
      status: 'passed',
      name: 'executor',
      count: tokens,
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

  /** Claims a mutation slot before any side effect, for both grammar and project tools. */
  private reserveAction(): void {
    this.checkpoint();
    if (this.closed) throw new AgentError('CANCELLED', 'the step has ended');
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
  }

  /** Records project tools through the same budget and operation queue as grammar actions. */
  private runTool<T>(call: { name: string; mutates: boolean }, body: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.checkpoint();
      if (this.closed) throw new AgentError('CANCELLED', 'the step has ended');
      if (call.mutates) {
        this.reserveAction();
        this.stepCache?.recordGap(call.name);
      }
      return instrumentPhase(
        this.runtime,
        { api: this.spec.api, kind: 'engine', phase: 'agent.action', name: `tool:${call.name}` },
        body,
      );
    };
    return call.mutates ? this.serialized(run) : run();
  }

  /** Attaches metrics, model provenance, and the verdict explanation to the step. */
  finish(): void {
    this.closed = true;
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
      // Model prose and project-tool output are not model input, but they
      // are a log: the same redactor that guards the tree guards the file.
      writeFileSync(join(this.runtime.artifacts.dir, name), this.redact(this.transcript), 'utf8');
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
    return this.usage.report({
      provider: this.modelProvider ?? executor.name,
      model: this.modelId ?? executor.name,
      endpoint: 'provider-default',
      adapterVersion: `executor/${executor.name}@${executorVersion}`,
      policyVersion: `${executor.name}/${executorVersion}`,
    }, this.metrics.modelCalls);
  }

  private get session() {
    return this.runtime.engine.session;
  }

  private operation(): OperationContext {
    return boundedOperation(this.runtime.engine, this.runtime.config.actionTimeout, this.deadline);
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
        signal: this.runtime.engine.signal,
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
   * Replay's pre-action looks and the cache session's probes settle through
   * the same path (`observeSettled`); only replay's polls between retries
   * read raw (`observeLatest`).
   */
  private async observe(options: ExecutorObserveOptions = {}): Promise<ExecutorObservation> {
    if (options === null || typeof options !== 'object') {
      throw new TestError('INVALID_ARGUMENT', 'observe options must be an object');
    }

    const wantPixels = options.pixels === true;
    const observation = await this.observeSettled(wantPixels);
    // Prefer location from this capture; only engines without it need a separate probe.
    const path = await this.currentPath(observation);
    return {
      revision: observation.revision,
      text: observation.text,
      truncated: observation.truncated,
      viewport: observation.viewport,
      ...(path === undefined ? {} : { path: this.redact(path) }),
      ...(options.tree === true ? { tree: projectTree(observation.tree, this.redact) } : {}),
      ...(wantPixels ? this.pixelsFor(observation) : {}),
    };
  }

  /**
   * Pixels for an executor that asked for them, or the reason they are
   * withheld — the same decision the judgment tier makes, recorded as a
   * policy event whenever it changes within the step.
   */
  private pixelsFor(observation: AgentObservation): Pick<ExecutorObservation, 'pixels' | 'pixelsWithheld'> {
    const outcome = pixelsForModel(observation, this.runtime.taint.value);
    if ('withheld' in outcome) {
      this.recordPixelDecision('denied', outcome.withheld);
      return { pixelsWithheld: outcome.withheld };
    }
    this.recordPixelDecision('allowed');
    this.metrics.pixelBytes = Math.max(this.metrics.pixelBytes ?? 0, outcome.pixels.data.byteLength);
    return { pixels: outcome.pixels };
  }

  private recordPixelDecision(decision: 'allowed' | 'denied', code?: string): void {
    const key = code ?? decision;
    if (this.pixelsDecided === key) return;
    this.pixelsDecided = key;
    this.recordPolicy('vision.pixels', decision, code);
  }

  private observeLatest(): Promise<AgentObservation> {
    return this.serialized(() => this.observeNow(false, false));
  }

  private observeSettled(pixels = false): Promise<AgentObservation> {
    return this.serialized(() => this.observeNow(true, pixels));
  }

  /** One recorded observation; when `settle`, the captures loop inside it. */
  private async observeNow(settle: boolean, pixels: boolean): Promise<AgentObservation> {
    this.checkpoint();
    // A tainted viewport never captures pixels: the engine would mask what it
    // knows about, and the secret may be anywhere on screen by now.
    const capturePixels = pixels && !this.runtime.taint.value;
    const observation = await instrumentPhase(
      this.runtime,
      { api: this.spec.api, kind: 'observation', phase: 'agent.observe' },
      () =>
        settle
          ? settleObservation(() => this.captureObservation(capturePixels), observationShape, {
              remainingMs: () => this.deadline.remaining(),
              // The step's own hard stop must interrupt a settle sleep too —
              // the attempt signal alone would let settling outlive the step
              // by one poll interval.
              signal: this.stepSignal,
            })
          : this.captureObservation(capturePixels),
      (prepared) => ({ count: prepared.nodes.size, bytes: prepared.bytes }),
    );
    this.latest = observation;
    this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
    return observation;
  }

  /** One raw observation capture: retried at the engine, then redacted and bounded. */
  private async captureObservation(pixels: boolean): Promise<AgentObservation> {
    const raw = await retryingObserve({
      observe: (operation) => this.session.observe(operation, { pixels }),
      operation: () => this.operation(),
      guard: (cause) => this.checkpoint(cause),
      signal: this.runtime.engine.signal,
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
   * Runs one grammar action against the action budget, recorded as an engine
   * event. The body performs the engine call and returns the committed
   * action's recordable descriptor — one value carries both concerns: the
   * event's `detail` prose derives from it in a pure hook, and the dispatch
   * writes it to the trace cache after the phase settles.
   */
  private runAction(name: string, body: () => Promise<RecordableAction>): Promise<void> {
    return this.serialized(() => this.runActionNow(name, body));
  }

  private async runActionNow(name: string, body: () => Promise<RecordableAction>): Promise<void> {
    this.reserveAction();
    let action: RecordableAction;
    try {
      action = await instrumentPhase(
        this.runtime,
        { api: this.spec.api, kind: 'engine', phase: 'agent.action', name },
        body,
        (committed) => ({
          detail: describeAction(committed, this.redact, this.runtime.config.testIdAttribute).summary,
        }),
      );
    } catch (cause) {
      this.checkpoint(cause);
      throw cause;
    }
    if (this.stepCache === undefined) return;
    // A typed value the step derived at run time is this run's data, not the
    // flow's: it is recorded as a gap so replay hands over before it rather
    // than typing a value the app may not issue again.
    if (action.name === 'type' && isDerivedValue(action.value, this.spec.instruction, this.spec.params)) {
      this.stepCache.recordGap('type (run-time value)');
      return;
    }
    this.stepCache.record(action);
  }

  /** One action against a resolved node; a stale ref asks for a re-observe. */
  private commitTargeted(
    name: string,
    target: ExecutorTarget,
    perform: (node: SemanticNode) => Promise<RecordableAction>,
  ): Promise<void> {
    return this.runAction(name, async () => {
      const node = this.resolveTarget(target);
      // The container the node sits in is captured with it: that is what
      // tells this row's "Delete" from the next row's when the flow replays.
      const latest = this.latest;
      const within =
        latest === undefined ? undefined : containerKey(node.ref.id, latest.nodes, latest.parents, this.redact);
      try {
        const action = await perform(node);
        return within === undefined ? action : { ...action, within };
      } catch (cause) {
        if (cause instanceof EngineError && cause.code === 'NODE_STALE') {
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

  private recordPolicy(name: string, decision: 'allowed' | 'denied', code?: string): void {
    recordPolicyEvent(this.runtime.steps, name, decision, code);
  }

  private async navigate(url: string): Promise<void> {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TestError('INVALID_ARGUMENT', 'navigate requires a URL');
    }
    const resolved = resolveNavigationUrl(
      url,
      this.runtime.app.base,
      this.runtime.app.allowedOrigins,
    ).url;
    // The raw argument is recorded, not the resolved URL: replay re-resolves
    // through the same base and origin policy this call just passed.
    await this.runAction('navigate', async () => {
      await this.session.app.open(resolved, this.operation());
      return { name: 'navigate', url };
    });
  }
}
