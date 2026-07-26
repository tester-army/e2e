/**
 * One bounded agent invocation (spec 02-test-api.md, 10-determinism.md).
 *
 * Every `agent.*` call is a separate invocation with a fresh observation, an
 * explicit deadline, a model-call budget, and no shared model transcript.
 */

import type { JSONSchema7 } from 'ai';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { DriverSession } from '../driver/index.ts';
import { E2EError, classifyError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
import type { LocatorEngine } from '../locator/engine.ts';
import type { SecretResolver } from '../locator/screen.ts';
import type { ArtifactSink } from '../run/fixtures.ts';
import type { StepMetrics, StepModelInfo, StepRecorder } from '../run/steps.ts';
import type { AgentErrorCode } from '../types.ts';
import { AgentError, isAgentError } from './error.ts';
import { Ledger } from './ledger.ts';
import { ModelOutputInvalidError, type ModelAdapter } from './model/adapter.ts';
import { prepareObservation, type AgentObservation } from './observation.ts';
import type { ProtocolValidation } from './protocol.ts';
import { POLICY_VERSION, buildPrompt, buildSystem, type PromptInput } from './prompts.ts';

/** Attempt-scoped services one agent fixture needs. */
export interface AgentContext {
  readonly engine: LocatorEngine;
  readonly steps: StepRecorder;
  readonly adapter: ModelAdapter;
  readonly config: ResolvedConfig;
  readonly ledger: Ledger;
  /** Trusted project context: config.agent.context then test/group agentContext. */
  readonly agentContext: string | undefined;
  readonly secrets: SecretResolver;
  /** Registered secret values, used only for runner-side redaction. */
  readonly secretValues: ReadonlyMap<string, string>;
  /** Set once any secret is filled; the viewport stays pixel-tainted after. */
  readonly taint: { value: boolean };
  readonly artifacts: ArtifactSink;
  readonly signal: AbortSignal;
}

export interface InvocationOptions {
  /** Public API name, e.g. `agent.tap`. */
  readonly api: string;
  /** Short task description placed in the system message. */
  readonly task: string;
  readonly timeoutMs: number;
  readonly maxModelCalls: number;
  readonly maxActionSteps: number;
  /** `false` disables the cache for this call; it can never upgrade the mode. */
  readonly cache: boolean;
}

const MAX_OUTPUT_TOKENS = 2048;

/** Headroom reserved for the method instruction and parameters. */
const INSTRUCTION_RESERVE_BYTES = 4_096;

/** Model-call accounting plus observation/ledger metrics for one invocation. */
export class Invocation {
  readonly deadline: Deadline;

  private readonly metrics: StepMetrics = {
    modelCalls: 0,
    actionSteps: 0,
    observationBytes: 0,
    contextBytes: 0,
    ledgerBytes: 0,
  };

  private inputTokens = 0;
  private outputTokens = 0;
  private peakTokensPerCall = 0;
  private accounting: 'provider' | 'adapter-upper-bound' = 'provider';
  private estimatedCostUsd: number | undefined;
  private observationRevision: string | undefined;
  private explanation: string | undefined;

  constructor(
    private readonly runtime: AgentContext,
    private readonly options: InvocationOptions,
  ) {
    this.deadline = runtime.engine.deadline(options.timeoutMs);
  }

  get engine(): LocatorEngine {
    return this.runtime.engine;
  }

  get session(): DriverSession {
    return this.runtime.engine.session;
  }

  /** Captures and redacts one fresh observation. */
  async observe(): Promise<AgentObservation> {
    this.checkDeadline();
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const raw = await this.session.observe(this.operation());
      const observation = prepareObservation(raw, {
        secrets: this.runtime.secretValues,
        maxBytes: this.observationByteBudget(),
        testIdAttribute: this.runtime.config.testIdAttribute,
      });
      this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
      this.runtime.steps.recordEvent({
        kind: 'observation',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'passed',
        count: observation.nodes.size,
        bytes: observation.bytes,
      });
      return observation;
    } catch (cause) {
      this.runtime.steps.recordEvent({
        kind: 'observation',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'failed',
        code: errorCode(cause),
      });
      throw toAgentError(cause);
    }
  }

  /**
   * Bytes one observation may contribute to a request.
   *
   * `agent.maxObservationBytes` is the configured ceiling, but the per-call
   * token limit binds first on a large page. Deriving the budget from what the
   * rest of the request actually costs makes a big page truncate visibly rather
   * than fail the adapter's pre-flight check.
   */
  private observationByteBudget(): number {
    const { config } = this.runtime;
    const overhead =
      byteLength(buildSystem(this.options.task, this.runtime.agentContext)) +
      this.runtime.ledger.serialize().bytes +
      INSTRUCTION_RESERVE_BYTES;
    const withinTokenCeiling = Math.max(1_024, config.limits.maxModelTokensPerCall - overhead);
    return Math.min(config.agent.maxObservationBytes, withinTokenCeiling);
  }

  /**
   * Performs one model call, retrying invalid output while budget and deadline
   * remain. Exhaustion is MODEL_OUTPUT_INVALID, never a guessed success.
   */
  async ask<Value>(request: {
    schemaName: string;
    schema: JSONSchema7;
    validate: (value: unknown) => ProtocolValidation<Value>;
    prompt: PromptInput;
  }): Promise<Value> {
    let repair: PromptInput['repair'] = request.prompt.repair;
    for (;;) {
      this.checkDeadline();
      this.consumeModelCall();
      const ledger = this.runtime.ledger.serialize();
      const system = buildSystem(this.options.task, this.runtime.agentContext);
      this.metrics.contextBytes = byteLength(this.runtime.agentContext ?? '');
      this.metrics.ledgerBytes = ledger.bytes;
      const prompt = buildPrompt({
        ...request.prompt,
        ledger: ledger.text,
        ...(repair === undefined ? {} : { repair }),
      });
      const startedAt = timestamp();
      const startedMs = Date.now();
      try {
        const result = await this.runtime.adapter.generate({
          system,
          prompt,
          schemaName: request.schemaName,
          schema: request.schema,
          validate: request.validate,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxInputTokens: this.runtime.config.limits.maxModelTokensPerCall,
          signal: this.runtime.signal,
          timeoutMs: Math.max(1, this.deadline.remaining()),
        });
        this.recordUsage(result.usage);
        this.runtime.steps.recordEvent({
          kind: 'model',
          startedAt,
          durationMs: Date.now() - startedMs,
          status: 'passed',
          name: request.schemaName,
          count: result.usage.inputTokens + result.usage.outputTokens,
        });
        return result.value;
      } catch (cause) {
        this.runtime.steps.recordEvent({
          kind: 'model',
          startedAt,
          durationMs: Date.now() - startedMs,
          status: cause instanceof AgentError && cause.code === 'CANCELLED' ? 'cancelled' : 'failed',
          name: request.schemaName,
          code: errorCode(cause),
        });
        if (
          cause instanceof ModelOutputInvalidError &&
          this.metrics.modelCalls < this.options.maxModelCalls &&
          !this.deadline.expired()
        ) {
          this.runtime.steps.recordEvent({
            kind: 'schema',
            startedAt: timestamp(),
            durationMs: 0,
            status: 'failed',
            name: request.schemaName,
            code: 'MODEL_OUTPUT_INVALID',
          });
          repair = {
            issue: cause.explanation,
            rawText: cause.rawText,
          };
          continue;
        }
        throw toAgentError(cause);
      }
    }
  }

  /** Runs one committed driver action against the action-step budget. */
  async commit<Value>(name: string, body: () => Promise<Value>): Promise<Value> {
    this.checkDeadline();
    if (this.metrics.actionSteps >= this.options.maxActionSteps) {
      throw new AgentError(
        'STEP_BUDGET_EXHAUSTED',
        `${this.options.api} exhausted its action-step budget of ${this.options.maxActionSteps}`,
      );
    }
    this.metrics.actionSteps += 1;
    const startedAt = timestamp();
    const startedMs = Date.now();
    try {
      const result = await body();
      this.runtime.steps.recordEvent({
        kind: 'driver',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'passed',
        name,
      });
      return result;
    } catch (cause) {
      this.runtime.steps.recordEvent({
        kind: 'driver',
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'failed',
        name,
        code: errorCode(cause),
      });
      throw toAgentError(cause);
    }
  }

  /** Records one policy decision as a child event. */
  recordPolicy(name: string, decision: 'allowed' | 'denied', code?: string): void {
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

  /** Records one polling round as a child event. */
  recordPoll(name: string, round: number): void {
    this.runtime.steps.recordEvent({
      kind: 'poll',
      startedAt: timestamp(),
      durationMs: 0,
      status: 'passed',
      name,
      count: round,
    });
  }

  /** Builds a driver operation context bounded by this invocation's deadline. */
  operation(): ReturnType<LocatorEngine['operation']> {
    return this.runtime.engine.operation(Math.max(1, this.deadline.remaining()));
  }

  /** Fails when the invocation deadline has elapsed. */
  checkDeadline(): void {
    if (this.runtime.signal.aborted) {
      throw new AgentError('CANCELLED', `${this.options.api} was cancelled`);
    }
    if (this.deadline.expired()) {
      throw new AgentError(
        'STEP_TIMEOUT',
        `${this.options.api} exceeded its ${this.options.timeoutMs} ms timeout`,
      );
    }
  }

  /** True while the model-call budget and deadline still allow one more call. */
  canAsk(): boolean {
    return this.metrics.modelCalls < this.options.maxModelCalls && !this.deadline.expired();
  }

  /**
   * Records report detail that must survive a later failure, such as the
   * observation revision and judgment explanation `agent.assert` requires.
   */
  note(details: { observationRevision?: string; explanation?: string }): void {
    if (details.observationRevision !== undefined) {
      this.observationRevision = details.observationRevision;
    }
    if (details.explanation !== undefined) this.explanation = details.explanation;
  }

  /** Attaches metrics, provenance, and cache status to the enclosing step. */
  finish(): void {
    this.runtime.steps.attachAgentDetails({
      metrics: { ...this.metrics },
      ...(this.metrics.modelCalls > 0 ? { model: this.modelInfo() } : {}),
      // The locate/path caches (cache-1) are not implemented yet, so every
      // invocation reports a bypass rather than a fabricated key hash.
      cache: { status: 'bypassed' },
      ...(this.observationRevision !== undefined
        ? { observationRevision: this.observationRevision }
        : {}),
      ...(this.explanation !== undefined ? { explanation: this.explanation } : {}),
    });
  }

  private modelInfo(): StepModelInfo {
    const provenance = this.runtime.adapter.provenance;
    return {
      provider: provenance.provider,
      model: provenance.model,
      endpoint: provenance.endpoint,
      adapterVersion: provenance.adapterVersion,
      policyVersion: POLICY_VERSION,
      calls: this.metrics.modelCalls,
      tokenAccounting: this.accounting,
      peakTokensPerCall: this.peakTokensPerCall,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.estimatedCostUsd !== undefined ? { estimatedCostUsd: this.estimatedCostUsd } : {}),
    };
  }

  private consumeModelCall(): void {
    if (this.metrics.modelCalls >= this.options.maxModelCalls) {
      throw new AgentError(
        'STEP_BUDGET_EXHAUSTED',
        `${this.options.api} exhausted its model-call budget of ${this.options.maxModelCalls}`,
      );
    }
    this.metrics.modelCalls += 1;
  }

  private recordUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    accounting: 'provider' | 'adapter-upper-bound';
    estimatedCostUsd: number | undefined;
  }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.peakTokensPerCall = Math.max(
      this.peakTokensPerCall,
      usage.inputTokens + usage.outputTokens,
    );
    if (usage.accounting === 'adapter-upper-bound') this.accounting = 'adapter-upper-bound';
    if (usage.estimatedCostUsd !== undefined) {
      this.estimatedCostUsd = (this.estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
    }
  }
}

const AGENT_CODES = new Set<string>([
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'MODEL_UNAVAILABLE',
  'MODEL_PROVIDER_FAILED',
  'MODEL_OUTPUT_INVALID',
  'APP_UNREACHABLE',
  'APP_NOT_OPEN',
  'LOCATOR_NOT_FOUND',
  'LOCATOR_AMBIGUOUS',
  'ACTION_FAILED',
  'CACHE_REPLAY_DIVERGED',
  'POLICY_DENIED',
  'STEP_BUDGET_EXHAUSTED',
  'STEP_TIMEOUT',
  'STEP_NO_CONCLUSION',
  'ASSERTION_FAILED',
  'CANCELLED',
]);

/**
 * Maps any runner error raised inside an invocation onto the closed agent code
 * set. Model prose can never select a code.
 */
export function toAgentError(cause: unknown): Error {
  if (isAgentError(cause)) return cause;
  const classified = cause instanceof E2EError ? cause : classifyError(cause);
  if (AGENT_CODES.has(classified.code)) {
    return new AgentError(classified.code as AgentErrorCode, classified.message, { cause });
  }
  if (classified.code === 'UNSUPPORTED_CAPABILITY' || classified.code === 'INVALID_CONFIG') {
    return new AgentError('POLICY_DENIED', classified.message, { cause });
  }
  if (classified.category === 'infrastructure') {
    return new AgentError('APP_UNREACHABLE', classified.message, { cause });
  }
  return new AgentError('ACTION_FAILED', classified.message, { cause });
}

function errorCode(cause: unknown): string {
  if (cause instanceof E2EError) return cause.code;
  return cause instanceof Error ? cause.name : 'ERROR';
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
