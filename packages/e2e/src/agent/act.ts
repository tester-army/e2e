/**
 * Harness-owned dispatch of one `agent.act()` step.
 *
 * The harness opens the step and hands only the thinking to the configured
 * executor; everything the executor can touch is built here from four
 * collaborators, each owning one concern of the step:
 *
 * - `StepAccounting`: the clock, the budgets, the hard stop, the metrics.
 * - `ObservationFeed`: every capture, the settle, the id ring, the pixel decision.
 * - `ActionDispatcher`: the verb table, target resolution, recording.
 * - `StepTraceSession`: replay, live recording, and the stage-or-evict decision.
 *
 * Capabilities beyond the grammar (secret fills, the trace cache) are modules
 * over those collaborators, borrowed through a small host each. What stays in
 * this file is the wiring, the executor's context, and the mapping of the
 * executor's verdict onto the runner's error taxonomy.
 */

import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import type { ActOptions, ActResult, AgentErrorCode, JsonValue, ModelInstance, Secret } from '../types.ts';
import { AgentError, CATEGORY_BY_CODE, isAgentError, toAgentError } from './error.ts';
import { validateActOptions, validateInstruction, validateParams, validateVerdict } from './act-validation.ts';
import { ActionDispatcher } from './action-dispatcher.ts';
import { resolveBoundedBudget, resolveTimeout } from './call-options.ts';
import { RUNTIME_CODES, type ExecutorPixels, type StepExecutorContext, type StepVerdict } from './executor.ts';
import type { AgentContext, AgentSelection } from './invocation.ts';
import { projectPriorSteps, serializeLedger } from './ledger.ts';
import { instantiateLanguageModel } from './model/sdk.ts';
import { ObservationFeed } from './observation-feed.ts';
import { OperationQueue } from './operation-queue.ts';
import { StepAccounting } from './step-accounting.ts';
import { StepTraceSession, type StepCacheHost, type StepOutcome } from './step-cache.ts';

/** What a dispatch needs of the agent a step runs with; an interactive step supplies its own. */
export type DispatchAgent = Pick<AgentSelection, 'name' | 'config' | 'executor' | 'agentContext'>;

/** Everything one dispatched step is, resolved before the step opens. */
export interface DispatchSpec {
  /** The public API the step ran as, or `session` for a step a host drives from outside the loop. */
  readonly api: 'agent.act' | 'agent.assert' | 'session';
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
  /** The configured agent the call named, if any. */
  readonly agent: string | undefined;
}

/** Runs one `agent.act()` call as a harness-dispatched executor step. */
export async function runActStep(
  runtime: AgentContext,
  instruction: string,
  options: ActOptions | undefined,
  extraArguments = 0,
): Promise<ActResult> {
  const normalized = validateInstruction(instruction, 'agent.act');
  validateActOptions(options, extraArguments);
  const { projected, secrets } = validateParams(options?.params);
  return dispatchAgentStep(runtime, {
    api: 'agent.act',
    kind: 'act',
    instruction: normalized,
    params: projected,
    secrets,
    defaultFailureCode: 'ACTION_FAILED',
    timeout: options?.timeout,
    maxSteps: options?.maxSteps,
    maxModelCalls: options?.maxModelCalls,
    agent: options?.agent,
  });
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
  options: { timeout?: number; vision?: unknown; screenshot?: boolean; agent?: string } | undefined,
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
    agent: options?.agent,
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
export async function dispatchAgentStep(
  runtime: AgentContext,
  spec: DispatchSpec,
  // Resolved before the step opens, so an unknown name fails the call, not a
  // recorded step, and the step carries the agent it ran with.
  agent: DispatchAgent = runtime.select(spec.agent),
): Promise<ActResult> {
  return runtime.steps.run('agent', spec.api, spec.instruction, async () => {
    const dispatch = new ActDispatch(runtime, spec, agent);
    try {
      let verdict: StepVerdict;
      try {
        verdict = await dispatch.run();
      } catch (cause) {
        throw dispatch.settleThrown(toAgentError(cause));
      }
      dispatch.settle(validateVerdict(verdict, agent.executor.name));
      await dispatch.conclude('passed');
      return dispatch.result();
    } catch (cause) {
      await dispatch.conclude(isAgentError(cause) && cause.code === 'CANCELLED' ? 'cancelled' : 'failed');
      throw cause;
    } finally {
      dispatch.finish();
    }
  }, { verifies: spec.kind === 'assert', agent: agent.name });
}

/** One step's wiring: the collaborators, the executor's context, and the verdict mapping. */
class ActDispatch {
  private readonly accounting: StepAccounting;
  private readonly feed: ObservationFeed;
  private readonly dispatcher: ActionDispatcher;
  /** The step's trace-cache session; undefined when caching is off or the kind is not cacheable. */
  private readonly stepCache: StepTraceSession | undefined;
  /** Timeline index of the step being dispatched. */
  private readonly stepIndex: number;
  private explanation: string | undefined;
  private transcript: string | undefined;
  private sdkModel: ModelInstance | undefined;
  private sdkModelResolved = false;

  constructor(
    private readonly runtime: AgentContext,
    private readonly spec: DispatchSpec,
    /** The agent this step runs with. */
    private readonly agent: DispatchAgent,
  ) {
    this.accounting = new StepAccounting(runtime, {
      api: spec.api,
      timeoutMs: resolveTimeout(spec.timeout, runtime.config.timeout),
      maxActions: resolveBoundedBudget(spec.maxSteps, agent.config.maxSteps, 'maxSteps'),
      maxModelCalls: resolveBoundedBudget(spec.maxModelCalls, agent.config.maxModelCalls, 'maxModelCalls'),
      contextBytes: new TextEncoder().encode(agent.agentContext ?? '').byteLength,
    });
    // One queue for observations and actions alike: call order is what keeps
    // a batched turn from resolving two targets against one stale screen.
    const queue = new OperationQueue();
    this.feed = new ObservationFeed(runtime, this.accounting, queue, {
      maxObservationBytes: agent.config.maxObservationBytes,
    });
    this.dispatcher = new ActionDispatcher(runtime, this.accounting, this.feed, queue, {
      instruction: spec.instruction,
      params: spec.params,
      secrets: spec.secrets,
      trace: () => this.stepCache,
    });
    // The dispatch always runs inside a recorded step (`dispatchAgentStep`
    // opens one); the index names the step to the executor and to the trace cache.
    const stepIndex = runtime.steps.currentStepIndex;
    if (stepIndex === undefined) throw new Error('agent step dispatched outside a recorded step');
    this.stepIndex = stepIndex;
    // Only act steps are cacheable: an assert must not change state, so its
    // trace would be empty — nothing to replay, nothing worth a read. An
    // executor that declared `cache: 'off'` sees every step itself.
    const cache = spec.kind === 'act' && agent.executor.cache !== 'off' ? runtime.cache : undefined;
    this.stepCache =
      cache === undefined
        ? undefined
        : new StepTraceSession(this.cacheHost(), {
            cache,
            instruction: spec.instruction,
            params: spec.params,
            executor: {
              name: agent.executor.name,
              ...(agent.executor.version === undefined ? {} : { version: agent.executor.version }),
            },
            redact: runtime.redact,
            testIdAttribute: runtime.config.testIdAttribute,
            maxActions: this.accounting.maxActions,
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
    this.accounting.metrics.ledgerBytes = ledger.bytes;
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
      signal: this.accounting.signal,
      // Resolved on first read, so executors that bring their own model (or
      // none) never pay for — or fail on — config model resolution.
      get model() {
        return dispatch.resolveModel();
      },
      providerOptions: this.agent.config.providerOptions,
      ledger: ledger.text,
      agentContext: this.agent.agentContext,
      budgets: {
        maxActions: this.accounting.maxActions,
        maxModelCalls: this.accounting.maxModelCalls,
        actionsUsed: () => this.accounting.metrics.actionSteps,
        remainingMs: () => this.accounting.remainingMs(),
        recordModelCall: (usage) => this.accounting.recordModelCall(usage),
        runTool: (call, body) => this.dispatcher.runTool(call, body),
      },
      observe: (options) => this.feed.observe(options),
      get pixelsTainted() {
        return dispatch.runtime.taint.value;
      },
      attachTranscript: (text) => {
        // Debug detail only: transcripts are model prose and can be large.
        if (this.runtime.debug?.enabled === true && typeof text === 'string' && text !== '') {
          this.transcript = text;
        }
      },
      attachScreenshot: (pixels, label) => this.attachScreenshot(pixels, label),
      actions: this.dispatcher.actions,
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
    const { accounting } = this;
    const timer = setTimeout(() => {
      accounting.fatalize(
        new AgentError('STEP_TIMEOUT', `${this.spec.api} exceeded its ${accounting.timeoutMs} ms timeout`),
      );
    }, Math.max(1, accounting.remainingMs()));
    try {
      return await Promise.race([
        this.dispatchStep(),
        new Promise<never>((_, reject) => {
          const { signal } = accounting;
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

  /** Hands the settled outcome to the cache session, which stages, evicts, or does nothing. */
  async conclude(outcome: StepOutcome): Promise<void> {
    await this.stepCache?.conclude(outcome, this.explanation);
  }

  /** Maps the executor's verdict onto the runner outcome. Fail-closed on hard stops. */
  settle(verdict: StepVerdict): void {
    let settled = verdict;
    const hardStop = this.accounting.hardStop;
    if (hardStop !== undefined) {
      if (hardStop.code === 'CANCELLED') throw hardStop;
      if (settled.status === 'passed') {
        // The step ran out of budget or time mid-flight; an executor cannot
        // declare success over the runtime's own accounting.
        settled = { status: 'blocked', summary: hardStop.message, errorCode: hardStop.code };
      } else if (settled.errorCode === undefined) {
        // The executor's analysis stands, but runtime exhaustion is never
        // hidden from the report: a code-less failure inherits the hard stop.
        settled = { ...settled, errorCode: hardStop.code };
      }
    }
    if (
      settled.errorCode !== undefined &&
      RUNTIME_CODES.has(settled.errorCode) &&
      !this.accounting.vouches(settled.errorCode)
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
    const hardStop = this.accounting.hardStop;
    if (hardStop !== undefined) return hardStop;
    if (this.accounting.vouches(error.code)) return error;
    return this.invented(error.code, error);
  }

  /** What the settled step did, for the caller of `agent.act()`. */
  result(): ActResult {
    const cache = this.stepCache?.cacheInfo;
    return {
      summary: this.explanation ?? '',
      ...(cache === undefined ? {} : { cache }),
      modelCalls: this.accounting.metrics.modelCalls,
      actions: this.accounting.metrics.actionSteps,
    };
  }

  /** Closes the books and attaches metrics, model provenance, and the verdict explanation to the step. */
  finish(): void {
    this.accounting.close();
    const { metrics } = this.accounting;
    const cacheInfo = this.stepCache?.cacheInfo;
    const latest = this.feed.latest;
    const model = this.accounting.modelInfo(this.agent.executor);
    this.runtime.steps.attachAgentDetails({
      metrics: { ...metrics },
      ...(model === undefined ? {} : { model }),
      ...(cacheInfo === undefined ? {} : { cache: cacheInfo }),
      ...(this.explanation !== undefined ? { explanation: this.explanation } : {}),
      ...(latest !== undefined ? { observationRevision: latest.revision } : {}),
      ...this.feed.visionReport(),
    });
    this.writeTranscript();
  }

  private async dispatchStep(): Promise<StepVerdict> {
    const replayed = await this.stepCache?.begin();
    if (replayed !== undefined) return replayed;
    return this.agent.executor.runStep(this.context());
  }

  /** The cache session's narrow view of this step. */
  private cacheHost(): StepCacheHost {
    return {
      observe: async () => (await this.feed.observeLatest()).nodes,
      observeSettled: async () => (await this.feed.observeSettled()).nodes,
      actions: this.dispatcher.actions,
      signal: this.accounting.signal,
      remainingMs: () => this.accounting.remainingMs(),
      redact: this.runtime.redact,
      testIdAttribute: this.runtime.config.testIdAttribute,
      currentPath: (nodes) => {
        const latest = this.feed.latest;
        return this.feed.currentPath(nodes !== undefined && nodes === latest?.nodes ? latest : undefined);
      },
      replaying: (active) => this.runtime.steps.replaying(active),
    };
  }

  private invented(code: AgentErrorCode, cause?: AgentError): AgentError {
    return new AgentError(
      'MODEL_OUTPUT_INVALID',
      `executor "${this.agent.executor.name}" reported runtime code ${code}, which the runtime never assigned`,
      cause === undefined ? {} : { cause },
    );
  }

  /**
   * Persists observed pixels as a step-attributed `screenshot` artifact and
   * returns its id. The pixels are the engine's redacted capture, so the file
   * is masked as every screenshot artifact is.
   */
  private async attachScreenshot(pixels: ExecutorPixels, label: string): Promise<string> {
    const name = `${label.replace(/[^A-Za-z0-9_-]+/g, '-')}.png`;
    await writeFile(join(this.runtime.artifacts.dir, name), pixels.data);
    const id = this.runtime.artifacts.register('screenshot', name);
    this.runtime.steps.attachArtifact(id);
    return id;
  }

  /** Persists the executor transcript as a step-attributed `log` artifact. */
  private writeTranscript(): void {
    if (this.transcript === undefined) return;
    const stepId = this.runtime.steps.currentStepId ?? 'act';
    const name = `transcript-${stepId.replace(/[^A-Za-z0-9_-]+/g, '-')}.txt`;
    try {
      // Model prose and project-tool output are not model input, but they
      // are a log: the same redactor that guards the tree guards the file.
      writeFileSync(join(this.runtime.artifacts.dir, name), this.runtime.redact(this.transcript), 'utf8');
      this.runtime.steps.attachArtifact(this.runtime.artifacts.register('log', name));
    } catch {
      // The transcript is best-effort debug detail; never fail the step for it.
    }
  }

  /** Resolves the configured model once; executors that never read it never pay. */
  private resolveModel(): ModelInstance | undefined {
    if (!this.sdkModelResolved) {
      const resolved = this.agent.config.model;
      this.sdkModel = resolved === undefined ? undefined : instantiateLanguageModel(resolved);
      this.sdkModelResolved = true;
    }
    return this.sdkModel;
  }
}
