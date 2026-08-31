/**
 * Harness-owned dispatch of one `agent.act()` step (RFC0001, layer 3).
 *
 * The harness opens the step, owns the deadline, the action budget, origin
 * policy, observation redaction, and recording — then hands the step to the
 * configured executor and maps its verdict back onto the runner's error
 * taxonomy. The executor never touches the driver: everything bottoms out in
 * the context built here, on the same accounting core (phases.ts) the
 * locate/judgment tier runs on.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DriverError, type NodeRef } from '../driver/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { validateJsonValue } from '../internal/json-value.ts';
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
} from '../types.ts';
import { AgentError, CATEGORY_BY_CODE, isAgentError, toAgentError } from './error.ts';
import { resolveBoundedBudget, resolveTimeout } from './call-options.ts';
import {
  BLOCKABLE_CODES,
  RUNTIME_CODES,
  type ExecutorModelCall,
  type ExecutorObservation,
  type ExecutorTarget,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import type { AgentContext } from './invocation.ts';
import { serializeLedger } from './ledger.ts';
import { instantiateLanguageModel } from './model/sdk.ts';
import { prepareObservation, type AgentObservation } from './observation.ts';
import { checkStepClock, instrumentPhase, retryingObserve } from './phases.ts';

const API = 'agent.act';

const MAX_SUMMARY_CHARS = 2_000;

/** Spec 02: instructions are 1 through 8 KiB UTF-8 after NFC. */
const MAX_INSTRUCTION_BYTES = 8_192;

/** Spec 02: canonical non-secret parameters are capped at 64 KiB, 32 levels. */
const MAX_PARAMS_BYTES = 65_536;
const MAX_PARAMS_DEPTH = 32;

/** Runs one `agent.act()` call as a harness-dispatched executor step. */
export async function runActStep(
  runtime: AgentContext,
  instruction: string,
  params: AgentParams | undefined,
  options: AgentOptions | undefined,
): Promise<AgentResult> {
  const normalized = validateInstruction(instruction);
  rejectUnsupportedOptions(options);
  const jsonParams = validateParams(params);
  return runtime.steps.run('agent', API, normalized, async () => {
    const dispatch = new ActDispatch(runtime, normalized, jsonParams, options);
    try {
      let verdict: StepVerdict;
      try {
        verdict = await dispatch.runExecutor();
      } catch (cause) {
        throw dispatch.settleThrown(toAgentError(cause));
      }
      return dispatch.settle(validateVerdict(verdict, runtime.executor.name));
    } finally {
      dispatch.finish();
    }
  });
}

/** Normalizes and bounds the instruction per spec 02. */
function validateInstruction(instruction: string): string {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', 'agent.act requires a non-empty instruction');
  }
  const normalized = instruction.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes > MAX_INSTRUCTION_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act instruction is ${bytes} bytes; the maximum is ${MAX_INSTRUCTION_BYTES}`,
    );
  }
  return normalized;
}

/** Options the socket does not support yet fail loudly, like `schema` does. */
function rejectUnsupportedOptions(options: AgentOptions | undefined): void {
  if (options === undefined) return;
  const unsupported = (name: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `agent.act ${name} is not part of this milestone`,
    );
  };
  if ('schema' in options && options.schema !== undefined) unsupported('structured output (options.schema)');
  if (options.vision !== undefined) unsupported('vision evidence (options.vision)');
  if (options.cache !== undefined) unsupported('caching (options.cache)');
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
  private sdkModel: ModelInstance | undefined;
  private sdkModelResolved = false;
  private transcript: string | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private peakTokensPerCall = 0;
  private providerReportedUsage = false;
  private modelProvider: string | undefined;
  private modelId: string | undefined;

  constructor(
    private readonly runtime: AgentContext,
    private readonly instruction: string,
    private readonly params: Readonly<Record<string, JsonValue>> | undefined,
    options: AgentOptions | undefined,
  ) {
    this.timeoutMs = resolveTimeout(options?.timeout, runtime.config.timeout);
    this.deadline = runtime.engine.deadline(this.timeoutMs);
    this.maxActions = resolveBoundedBudget(
      options?.maxSteps,
      runtime.config.agent.maxSteps,
      'maxSteps',
    );
    this.maxModelCalls = resolveBoundedBudget(
      options?.maxModelCalls,
      runtime.config.agent.maxModelCalls,
      'maxModelCalls',
    );
    this.metrics.contextBytes = new TextEncoder().encode(runtime.agentContext ?? '').byteLength;
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
    return {
      step: {
        kind: 'act',
        instruction: this.instruction,
        params: this.params,
      },
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
      actions: {
        tap: (target) =>
          this.commitTargeted('tap', target, (ref) =>
            this.session.actions.tap({ ref }, this.operation()),
          ),
        type: (target, value) => {
          if (typeof value !== 'string') {
            throw new TestError('INVALID_ARGUMENT', 'type value must be a string');
          }
          return this.commitTargeted('type', target, (ref) =>
            this.session.actions.type({ ref }, value, false, this.operation()),
          );
        },
        press: (target, key) => {
          if (typeof key !== 'string' || key.trim() === '' || key.length > 64) {
            throw new TestError('INVALID_ARGUMENT', 'press key must be a short non-empty string');
          }
          return this.commitTargeted('press', target, (ref) =>
            this.session.screen.perform(ref, { kind: 'press', key }, this.operation()),
          );
        },
        select: (target, value) => {
          if (typeof value !== 'string' || value === '') {
            throw new TestError('INVALID_ARGUMENT', 'select value must be a non-empty option label');
          }
          return this.commitTargeted('selectOption', target, (ref) =>
            this.session.screen.perform(
              ref,
              { kind: 'selectOption', value },
              this.operation(),
            ),
          );
        },
        scroll: (direction, target) => this.scroll(direction, target),
        navigate: (url) => this.navigate(url),
      },
    };
  }

  /**
   * Races the executor against the step deadline. An executor that ignores
   * every context call still cannot outlive the clock: the timer records the
   * timeout as the hard stop, aborts the step signal, and settles the step —
   * the executor's promise is abandoned, never awaited past the deadline.
   */
  async runExecutor(): Promise<StepVerdict> {
    const timer = setTimeout(() => {
      this.fatalize(
        new AgentError('STEP_TIMEOUT', `agent.act exceeded its ${this.timeoutMs} ms timeout`),
      );
    }, Math.max(1, this.deadline.remaining()));
    try {
      return await Promise.race([
        this.runtime.executor.runStep(this.context()),
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

  /** Maps the executor's verdict onto the runner outcome. Fail-closed on hard stops. */
  settle(verdict: StepVerdict): AgentResult {
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
    if (settled.status === 'passed') return { ok: true };
    const code =
      settled.errorCode !== undefined && settled.errorCode in CATEGORY_BY_CODE
        ? settled.errorCode
        : 'ACTION_FAILED';
    throw new AgentError(code, `agent.act ${settled.status}: ${settled.summary}`, {
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
          `agent.act exhausted its model-call budget of ${this.maxModelCalls}`,
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
      kind: 'driver',
      startedAt: timestamp(),
      durationMs: Math.max(0, Math.round(call.durationMs ?? 0)),
      status: 'passed',
      name: `tool:${call.name}`,
    });
    if (!call.mutates) return;
    this.metrics.actionSteps += 1;
    if (this.metrics.actionSteps > this.maxActions) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `agent.act exhausted its action budget of ${this.maxActions}`,
        ),
      );
    }
  }

  /** Attaches metrics, model provenance, and the verdict explanation to the step. */
  finish(): void {
    this.runtime.steps.attachAgentDetails({
      metrics: { ...this.metrics },
      ...(this.metrics.modelCalls > 0 ? { model: this.modelInfo() } : {}),
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
    };
  }

  private get session() {
    return this.runtime.engine.session;
  }

  private operation() {
    return this.runtime.engine.operation(Math.max(1, this.deadline.remaining()));
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
        api: API,
        timeoutMs: this.timeoutMs,
        ...(cause === undefined ? {} : { cause }),
      });
    } catch (error) {
      if (isAgentError(error)) this.fatalize(error);
      throw error;
    }
  }

  private async observe(): Promise<ExecutorObservation> {
    this.checkpoint();
    const observation = await instrumentPhase(
      this.runtime,
      { api: API, kind: 'observation', phase: 'agent.observe' },
      async () => {
        const raw = await retryingObserve({
          observe: (operation) => this.session.observe(operation, { pixels: false }),
          operation: () => this.operation(),
          guard: (cause) => this.checkpoint(cause),
          signal: this.runtime.signal,
          api: API,
        });
        return prepareObservation(raw, {
          secrets: this.runtime.secretValues,
          maxBytes: this.runtime.config.agent.maxObservationBytes,
          testIdAttribute: this.runtime.config.testIdAttribute,
        });
      },
      (prepared) => ({ count: prepared.nodes.size, bytes: prepared.bytes }),
    );
    this.latest = observation;
    this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
    return {
      revision: observation.revision,
      text: observation.text,
      truncated: observation.truncated,
      viewport: observation.viewport,
    };
  }

  /** Resolves an executor target against the newest observation. */
  private resolveTarget(target: ExecutorTarget): NodeRef {
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
    return node.ref;
  }

  /** Runs one grammar action against the action budget, recorded as a driver event. */
  private async runAction(name: string, body: () => Promise<void>): Promise<void> {
    this.checkpoint();
    if (this.metrics.actionSteps >= this.maxActions) {
      throw this.fatalize(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `agent.act exhausted its action budget of ${this.maxActions}`,
        ),
      );
    }
    // The budget slot is consumed either way: a failed dispatch was an attempt.
    this.metrics.actionSteps += 1;
    try {
      await instrumentPhase(
        this.runtime,
        { api: API, kind: 'driver', phase: 'agent.action', name },
        body,
      );
    } catch (cause) {
      this.checkpoint(cause);
      throw cause;
    }
  }

  /** One action against a resolved node; a stale ref asks for a re-observe. */
  private commitTargeted(
    name: string,
    target: ExecutorTarget,
    body: (ref: NodeRef) => Promise<void>,
  ): Promise<void> {
    return this.runAction(name, async () => {
      const ref = this.resolveTarget(target);
      try {
        await body(ref);
      } catch (cause) {
        if (cause instanceof DriverError && cause.code === 'NODE_STALE') {
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
      await this.runAction('scroll', () =>
        this.session.actions.scroll(direction, {}, this.operation()),
      );
      return;
    }
    await this.commitTargeted('scroll', target, (ref) =>
      this.session.actions.scroll(direction, { target: ref }, this.operation()),
    );
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
    await this.runAction('navigate', () => this.session.app.open(resolved, this.operation()));
  }
}

/**
 * Rejects non-JSON parameters and returns an inert snapshot. The JSON
 * round-trip is deliberate: it bounds the canonical size (spec 02) and
 * freezes what the executor sees, so a getter or proxy cannot change values
 * — or run code — during later prompt serialization.
 */
function validateParams(
  params: AgentParams | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (params === undefined) return undefined;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params must be a plain object');
  }
  validateJsonValue(params, 'agent.act params', {
    maxDepth: MAX_PARAMS_DEPTH,
    onSecret: (label): never => {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `${label} must not contain a Secret; secret parameters land with agent.login`,
      );
    },
  });
  const canonical = JSON.stringify(params);
  const bytes = new TextEncoder().encode(canonical).byteLength;
  if (bytes > MAX_PARAMS_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act params are ${bytes} canonical bytes; the maximum is ${MAX_PARAMS_BYTES}`,
    );
  }
  return JSON.parse(canonical) as Readonly<Record<string, JsonValue>>;
}

/** Closes the verdict grammar: the executor cannot invent statuses or codes. */
function validateVerdict(verdict: unknown, executorName: string): StepVerdict {
  const invalid = (issue: string): never => {
    throw new AgentError(
      'MODEL_OUTPUT_INVALID',
      `executor "${executorName}" returned an invalid verdict: ${issue}`,
    );
  };
  if (typeof verdict !== 'object' || verdict === null) return invalid('not an object');
  const candidate = verdict as Record<string, unknown>;
  const status = candidate['status'];
  if (status !== 'passed' && status !== 'failed' && status !== 'blocked') {
    return invalid(`status must be passed, failed, or blocked, got ${JSON.stringify(status)}`);
  }
  const summary = candidate['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    return invalid('summary must be a non-empty string');
  }
  const errorCode = candidate['errorCode'];
  if (errorCode !== undefined) {
    if (typeof errorCode !== 'string' || !(errorCode in CATEGORY_BY_CODE)) {
      return invalid(`unknown errorCode ${JSON.stringify(errorCode)}`);
    }
  }
  const code = errorCode as AgentErrorCode | undefined;
  if (status === 'passed' && code !== undefined) {
    return invalid('a passed verdict cannot carry an errorCode');
  }
  if (status === 'blocked' && (code === undefined || !BLOCKABLE_CODES.has(code))) {
    return invalid(
      `blocked requires a blockable errorCode (one of ${[...BLOCKABLE_CODES].join(', ')})`,
    );
  }
  return {
    status,
    summary: summary.trim().slice(0, MAX_SUMMARY_CHARS),
    ...(code === undefined ? {} : { errorCode: code }),
  };
}
