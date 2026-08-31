/**
 * Harness-owned dispatch of one `agent.act()` step (RFC0001, layer 3).
 *
 * The harness opens the step, owns the deadline, the action budget, origin
 * policy, observation redaction, and recording — then hands the step to the
 * configured executor and maps its verdict back onto the runner's error
 * taxonomy. The executor never touches the driver: everything bottoms out in
 * the context built here.
 */

import { DriverError, type NodeRef } from '../driver/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import type { Deadline } from '../internal/time.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import { isSecret } from '../locator/screen.ts';
import type { StepMetrics } from '../run/steps.ts';
import type {
  AgentErrorCode,
  AgentOptions,
  AgentParams,
  AgentResult,
  JsonValue,
  ScrollDirection,
} from '../types.ts';
import { AgentError, CATEGORY_BY_CODE } from './error.ts';
import {
  BLOCKABLE_CODES,
  type ExecutorObservation,
  type ExecutorTarget,
  type StepExecutorContext,
  type StepVerdict,
} from './executor.ts';
import { toAgentError, type AgentContext } from './invocation.ts';
import { serializeLedger } from './ledger.ts';
import { instantiateLanguageModel } from './model/sdk.ts';
import { prepareObservation, type AgentObservation } from './observation.ts';

/** Codes only the runtime may assign; a verdict can carry but never invent them. */
const RUNTIME_CODES: ReadonlySet<string> = new Set([
  'STEP_BUDGET_EXHAUSTED',
  'STEP_TIMEOUT',
  'CANCELLED',
]);

const MAX_SUMMARY_CHARS = 2_000;

/** Runs one `agent.act()` call as a harness-dispatched executor step. */
export async function runActStep(
  runtime: AgentContext,
  instruction: string,
  params: AgentParams | undefined,
  options: AgentOptions | undefined,
): Promise<AgentResult> {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', 'agent.act requires a non-empty instruction');
  }
  if (options !== undefined && 'schema' in options && options.schema !== undefined) {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      'agent.act structured output (options.schema) is not part of this milestone',
    );
  }
  const jsonParams = validateParams(params);
  return runtime.steps.run('agent', 'agent.act', instruction, async () => {
    const dispatch = new ActDispatch(runtime, instruction, jsonParams, options);
    try {
      let verdict: StepVerdict;
      try {
        verdict = await runtime.executor.runStep(dispatch.context());
      } catch (cause) {
        throw dispatch.preferHardStop(toAgentError(cause));
      }
      return dispatch.settle(validateVerdict(verdict, runtime.executor.name));
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

  constructor(
    private readonly runtime: AgentContext,
    private readonly instruction: string,
    private readonly params: Readonly<Record<string, JsonValue>> | undefined,
    options: AgentOptions | undefined,
  ) {
    this.deadline = runtime.engine.deadline(
      resolveBudget(options?.timeout, runtime.config.timeout, 'timeout'),
    );
    this.maxActions = resolveBudget(options?.maxSteps, runtime.config.agent.maxSteps, 'maxSteps');
    this.maxModelCalls = resolveBudget(
      options?.maxModelCalls,
      runtime.config.agent.maxModelCalls,
      'maxModelCalls',
    );
  }

  /** Builds the executor-facing context. */
  context(): StepExecutorContext {
    const runtime = this.runtime;
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
      signal: this.runtime.signal,
      // A getter, so executors that bring their own model (or none) never pay
      // for — or fail on — config model resolution they do not use.
      get model() {
        const resolved = runtime.config.agent.model;
        return resolved === undefined ? undefined : instantiateLanguageModel(resolved);
      },
      ledger: ledger.text,
      agentContext: this.runtime.agentContext,
      budgets: {
        maxActions: this.maxActions,
        maxModelCalls: this.maxModelCalls,
        actionsUsed: () => this.metrics.actionSteps,
        remainingMs: () => this.deadline.remaining(),
        recordModelCall: (usage) => {
          this.metrics.modelCalls += 1;
          void usage;
        },
      },
      observe: () => this.observe(),
      actions: {
        tap: (target) =>
          this.commit('tap', target, (ref) =>
            this.session.actions.tap({ ref: ref as NodeRef }, this.operation()),
          ),
        type: (target, value) => {
          if (typeof value !== 'string') {
            throw new TestError('INVALID_ARGUMENT', 'type value must be a string');
          }
          return this.commit('type', target, (ref) =>
            this.session.actions.type({ ref: ref as NodeRef }, value, false, this.operation()),
          );
        },
        press: (target, key) => {
          if (typeof key !== 'string' || key.trim() === '' || key.length > 64) {
            throw new TestError('INVALID_ARGUMENT', 'press key must be a short non-empty string');
          }
          return this.commit('press', target, (ref) =>
            this.session.screen.perform(ref as NodeRef, { kind: 'press', key }, this.operation()),
          );
        },
        scroll: (direction, target) => this.scroll(direction, target),
        navigate: (url) => this.navigate(url),
      },
    };
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
      }
    }
    this.explanation = settled.summary;
    if (settled.status === 'passed') return { ok: true };
    const code =
      settled.errorCode !== undefined && settled.errorCode in CATEGORY_BY_CODE
        ? settled.errorCode
        : 'ACTION_FAILED';
    throw new AgentError(code, `agent.act ${settled.status}: ${settled.summary}`);
  }

  /** Re-raises the recorded hard stop over a derived executor failure. */
  preferHardStop(error: AgentError): AgentError {
    if (this.hardStop !== undefined && RUNTIME_CODES.has(error.code)) return this.hardStop;
    return error;
  }

  /** Attaches metrics and the verdict explanation to the enclosing step. */
  finish(): void {
    this.runtime.steps.attachAgentDetails({
      metrics: { ...this.metrics },
      ...(this.explanation !== undefined ? { explanation: this.explanation } : {}),
      ...(this.latest !== undefined ? { observationRevision: this.latest.revision } : {}),
    });
  }

  private get session() {
    return this.runtime.engine.session;
  }

  private operation() {
    return this.runtime.engine.operation(Math.max(1, this.deadline.remaining()));
  }

  /** Fails when the step is cancelled or out of time; records the hard stop. */
  private checkpoint(): void {
    if (this.runtime.signal.aborted) {
      throw this.fatal(new AgentError('CANCELLED', 'agent.act was cancelled'));
    }
    if (this.deadline.expired()) {
      throw this.fatal(
        new AgentError('STEP_TIMEOUT', 'agent.act exceeded its step timeout'),
      );
    }
  }

  private fatal(error: AgentError): AgentError {
    this.hardStop ??= error;
    return error;
  }

  private async observe(): Promise<ExecutorObservation> {
    this.checkpoint();
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const raw = await this.session.observe(this.operation(), { pixels: false });
      const observation = prepareObservation(raw, {
        secrets: this.runtime.secretValues,
        maxBytes: this.runtime.config.agent.maxObservationBytes,
        testIdAttribute: this.runtime.config.testIdAttribute,
      });
      this.latest = observation;
      this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
      this.runtime.steps.recordEvent({
        kind: 'observation',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'passed',
        count: observation.nodes.size,
        bytes: observation.bytes,
      });
      return {
        revision: observation.revision,
        text: observation.text,
        truncated: observation.truncated,
        viewport: observation.viewport,
      };
    } catch (cause) {
      this.runtime.steps.recordEvent({
        kind: 'observation',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'failed',
      });
      this.checkpoint();
      throw toAgentError(cause);
    }
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
  private async commit(
    name: string,
    target: ExecutorTarget | undefined,
    body: (ref: NodeRef | undefined) => Promise<void>,
  ): Promise<void> {
    this.checkpoint();
    if (this.metrics.actionSteps >= this.maxActions) {
      throw this.fatal(
        new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `agent.act exhausted its action budget of ${this.maxActions}`,
        ),
      );
    }
    // The ref is resolved before the budget is spent on dispatch work, but the
    // slot is consumed either way: a failed dispatch was still an attempt.
    this.metrics.actionSteps += 1;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const ref = target === undefined ? undefined : this.resolveTarget(target);
      await body(ref);
      this.runtime.steps.recordEvent({
        kind: 'driver',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'passed',
        name,
      });
    } catch (cause) {
      const error = toAgentError(cause);
      this.runtime.steps.recordEvent({
        kind: 'driver',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
        name,
        code: error.code,
      });
      this.checkpoint();
      if (cause instanceof DriverError && cause.code === 'NODE_STALE') {
        throw new AgentError(
          'LOCATOR_NOT_FOUND',
          'the target node is stale; re-observe and use a current id',
          { cause },
        );
      }
      throw error;
    }
  }

  private async scroll(direction: ScrollDirection, target: ExecutorTarget | undefined): Promise<void> {
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new TestError('INVALID_ARGUMENT', `invalid scroll direction "${String(direction)}"`);
    }
    if (target === undefined) {
      await this.commit('scroll', undefined, () =>
        this.session.actions.scroll(direction, {}, this.operation()),
      );
      return;
    }
    await this.commit('scroll', target, (ref) =>
      this.session.actions.scroll(direction, { target: ref as NodeRef }, this.operation()),
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
    await this.commit('navigate', undefined, () =>
      this.session.app.open(resolved, this.operation()),
    );
  }
}

/** Rejects non-JSON parameters. Secrets in `act` params land with `login`. */
function validateParams(
  params: AgentParams | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (params === undefined) return undefined;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params must be a plain object');
  }
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TestError('INVALID_ARGUMENT', `agent.act param ${path} is not a finite number`);
      }
      return;
    }
    if (typeof value === 'object') {
      if (isSecret(value)) {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `agent.act param ${path} is a Secret; secret parameters land with agent.login`,
        );
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
        return;
      }
      for (const [key, entry] of Object.entries(value)) visit(entry, `${path}.${key}`);
      return;
    }
    throw new TestError('INVALID_ARGUMENT', `agent.act param ${path} must be JSON-safe`);
  };
  for (const [key, value] of Object.entries(params)) visit(value, key);
  return params as Readonly<Record<string, JsonValue>>;
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

/** Resolves one per-call budget override against the configured limit. */
function resolveBudget(requested: number | undefined, fallback: number, label: string): number {
  if (requested === undefined) return fallback;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return requested;
}
