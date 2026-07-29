/**
 * One bounded agent invocation (spec 02-test-api.md, 10-determinism.md).
 *
 * Every `agent.*` call is a separate invocation with a fresh observation, an
 * explicit deadline, a model-call budget, and no shared model transcript.
 */

import type { JSONSchema7 } from 'ai';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { DriverSession } from '../driver/index.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { E2EError, classifyError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
import { agentTrace, observationTrace } from '../internal/trace.ts';
import type { LocatorEngine } from '../locator/engine.ts';
import type { SecretResolver } from '../locator/screen.ts';
import type { ArtifactSink } from '../run/fixtures.ts';
import type {
  StepEvent,
  StepMetrics,
  StepModelInfo,
  StepRecord,
  StepRecorder,
  VisionDegradation,
} from '../run/steps.ts';
import type { AgentErrorCode, VisionMode } from '../types.ts';
import { AgentError, CATEGORY_BY_CODE, isAgentError } from './error.ts';
import { serializeLedger, type LedgerContext } from './ledger.ts';
import {
  imageTokenUpperBound,
  ModelOutputInvalidError,
  tokenUpperBound,
  type ModelAdapter,
  type ModelImage,
} from './model/adapter.ts';
import type { ModelRouter } from './model/router.ts';
import { prepareObservation, type AgentObservation } from './observation.ts';
import type { ProtocolValidation } from './protocol.ts';
import { POLICY_VERSION, buildPrompt, buildSystem, type PromptInput } from './prompts.ts';

/** Attempt-scoped services one agent fixture needs. */
export interface AgentContext {
  readonly engine: LocatorEngine;
  readonly steps: StepRecorder;
  /** Chooses the model for a call; a vision call may use a pinned one. */
  readonly models: ModelRouter;
  readonly config: ResolvedConfig;
  /** Completed steps quoted as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted project context: config.agent.context then test/group agentContext. */
  readonly agentContext: string | undefined;
  readonly secrets: SecretResolver;
  /** Registered secret values, used only for runner-side redaction. */
  readonly secretValues: ReadonlyMap<string, string>;
  /** Set once any secret is filled; the viewport stays pixel-tainted after. */
  readonly taint: { value: boolean };
  readonly artifacts: ArtifactSink;
  readonly signal: AbortSignal;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
}

export interface InvocationOptions {
  /** Public API name, e.g. `agent.tap`. */
  readonly api: string;
  /** Caller's instruction, e.g. the target phrase, used for debug step labels. */
  readonly label?: string;
  /** Short task description placed in the system message. */
  readonly task: string;
  readonly timeoutMs: number;
  readonly maxModelCalls: number;
  readonly maxActionSteps: number;
  /** `false` disables the cache for this call; it can never upgrade the mode. */
  readonly cache: boolean;
  /**
   * Whether masked viewport pixels travel alongside the semantic tree.
   * Additive in every mode: the tree is always sent, and pixel evidence
   * degrades away under taint or unprovable masking rather than failing the
   * call. `'fallback'` starts tree-only and can be escalated once, by a caller
   * that has a signal the tree was not enough.
   */
  readonly vision: VisionMode;
}

const MAX_OUTPUT_TOKENS = 2048;

/**
 * Headroom reserved for the method instruction and parameters, in the
 * byte-scaled units `tokenUpperBound` works in.
 */
const INSTRUCTION_RESERVE = 4_096;

/**
 * Headroom reserved for one attached screenshot on a vision call, in the same
 * units.
 *
 * The exact cost is only known once the observation reports its viewport, which
 * is after the observation budget has to be fixed, so this reserves for the
 * largest viewport worth planning for. It is derived through the same function
 * the adapter bills with, rather than guessed, so the two cannot drift: a
 * hard-coded 4,096 was already short of a 1440p capture at 4,784.
 *
 * Reserving too much only costs observation bytes when the per-call token ceiling
 * binds, and there a truncated tree the model can see is better than the
 * adapter's pre-flight rejecting the call outright. A viewport beyond this is
 * still safe for that reason: the pre-flight computes the real figure.
 */
const PIXEL_RESERVE = imageTokenUpperBound({ width: 2_560, height: 1_440 });

/** One instrumented phase: the event kind it records and the debug bucket it feeds. */
interface PhaseSpec {
  readonly kind: StepEvent['kind'];
  readonly phase: 'agent.observe' | 'agent.model' | 'agent.action';
  readonly name?: string;
}

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

  /**
   * Trusted system message and serialized prior-step ledger. Both are
   * invariant for the invocation's lifetime — steps complete only between
   * invocations — so they are computed exactly once.
   */
  private readonly system: string;
  private readonly ledger: LedgerContext;

  private inputTokens = 0;
  private outputTokens = 0;
  private peakTokensPerCall = 0;
  private accounting: 'provider' | 'adapter-upper-bound' = 'provider';
  private estimatedCostUsd: number | undefined;
  private observationRevision: string | undefined;
  private explanation: string | undefined;
  private visionInput = false;
  private visionDegraded: VisionDegradation | undefined;
  /**
   * Whether pixels are currently part of this invocation's requests.
   *
   * It is the one piece of invocation state that moves: `'fallback'` starts on
   * the tree and is escalated at most once, so both the observation request and
   * the model choice follow from a single value instead of each deriving the
   * tier for itself.
   */
  private pixelTier: boolean;
  private visionEscalated = false;

  constructor(
    private readonly runtime: AgentContext,
    private readonly options: InvocationOptions,
  ) {
    this.deadline = runtime.engine.deadline(options.timeoutMs);
    this.pixelTier = options.vision === true || options.vision === 'only';
    this.system = buildSystem(options.task, runtime.agentContext);
    this.ledger = serializeLedger(runtime.priorSteps(), runtime.config.limits.maxLedgerBytes);
    agentTrace(
      () =>
        `${options.api} ${JSON.stringify(options.label ?? '')} start ` +
        `(timeout ${options.timeoutMs}ms, budget ${options.maxModelCalls} calls, ledger ${this.ledger.bytes}B)`,
    );
  }

  /** Public API name of the method being run, e.g. `agent.tap`. */
  get api(): string {
    return this.options.api;
  }

  get engine(): LocatorEngine {
    return this.runtime.engine;
  }

  get session(): DriverSession {
    return this.runtime.engine.session;
  }

  /**
   * The model this invocation talks to. It follows the pixel tier, so an
   * escalated fallback invocation asks the pinned vision model — the reason
   * for escalating is that the cheaper model's tree-only answer missed.
   */
  private get adapter(): ModelAdapter {
    return this.runtime.models.select(this.pixelTier);
  }

  /**
   * Whether the semantic tree reaches the model.
   *
   * `'only'` withholds it: a tree sent next to pixels is a cheaper path to an
   * answer than looking at them. The observation is still captured, because the
   * runner hit-tests and reports against it.
   */
  get treeWithheld(): boolean {
    return this.options.vision === 'only';
  }

  /**
   * True while this invocation may still be escalated to pixels.
   *
   * Only a caller holding a signal that the tree was insufficient may escalate,
   * and only once: a second miss with pixels attached is a real miss, not a
   * reason to keep spending the budget.
   */
  canEscalateVision(): boolean {
    return this.options.vision === 'fallback' && !this.pixelTier && this.canAsk();
  }

  /**
   * Attaches pixels to every following request of this invocation.
   *
   * Recorded on the step because it changes what the model saw and, when a
   * vision model is pinned, which model answered.
   */
  escalateVision(): void {
    if (this.pixelTier) return;
    this.pixelTier = true;
    this.visionEscalated = true;
    this.recordPolicy('vision.escalate', 'allowed');
    agentTrace(() => `${this.options.api} escalating to pixel evidence after a tree-only miss`);
  }

  /**
   * Runs one phase with uniform accounting: a child event on success and
   * failure, one debug bucket, and translation onto the closed agent error
   * set. Every observe/model/action phase goes through here so the records
   * cannot drift apart.
   */
  private async instrument<Value>(
    spec: PhaseSpec,
    body: () => Promise<Value>,
    detail?: (value: Value) => Partial<StepEvent>,
  ): Promise<Value> {
    const startedAt = timestamp();
    const startedMs = Date.now();
    const label = spec.name === undefined ? spec.kind : `${spec.kind}:${spec.name}`;
    try {
      const value = await body();
      const eventDetail = detail?.(value);
      this.runtime.steps.recordEvent({
        kind: spec.kind,
        startedAt,
        durationMs: Date.now() - startedMs,
        status: 'passed',
        ...(spec.name === undefined ? {} : { name: spec.name }),
        ...eventDetail,
      });
      agentTrace(
        () =>
          `${this.options.api} ${label} passed ${Date.now() - startedMs}ms` +
          `${eventDetail?.count !== undefined ? ` count=${eventDetail.count}` : ''}` +
          `${eventDetail?.bytes !== undefined ? ` bytes=${eventDetail.bytes}` : ''}`,
      );
      return value;
    } catch (cause) {
      this.runtime.steps.recordEvent({
        kind: spec.kind,
        startedAt,
        durationMs: Date.now() - startedMs,
        status: cause instanceof AgentError && cause.code === 'CANCELLED' ? 'cancelled' : 'failed',
        ...(spec.name === undefined ? {} : { name: spec.name }),
        code: errorCode(cause),
      });
      agentTrace(
        () =>
          `${this.options.api} ${label} failed ${Date.now() - startedMs}ms ` +
          `${errorCode(cause)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      throw toAgentError(cause);
    } finally {
      this.runtime.debug?.record(spec.phase, Date.now() - startedMs);
    }
  }

  /** Captures and redacts one fresh observation. */
  async observe(): Promise<AgentObservation> {
    this.checkDeadline();
    const pixels = this.pixelsRequested();
    const observation = await this.instrument(
      { kind: 'observation', phase: 'agent.observe' },
      async () => {
        const raw = await this.session.observe(this.operation(), { pixels });
        return prepareObservation(raw, {
          secrets: this.runtime.secretValues,
          maxBytes: this.observationByteBudget(),
          testIdAttribute: this.runtime.config.testIdAttribute,
        });
      },
      (prepared) => ({ count: prepared.nodes.size, bytes: prepared.bytes }),
    );
    // Bytes the request carried, so a withheld tree reads as the zero it is.
    if (!this.treeWithheld) {
      this.metrics.observationBytes = Math.max(this.metrics.observationBytes, observation.bytes);
    }
    this.observationRevision = observation.revision;
    if (pixels) this.recordPixels(observation);
    observationTrace(
      () =>
        `${this.options.api} ${observation.revision} (${observation.nodes.size} nodes, ${observation.bytes}B${
          observation.truncated ? ', truncated' : ''
        }${describePixels(observation)})`,
      observation.text,
    );
    return observation;
  }

  /**
   * Whether this observation should carry pixels. A tainted viewport degrades
   * the call to tree-only input instead of failing it: the tree is still fully
   * redacted, and only the unprovable evidence is dropped.
   */
  private pixelsRequested(): boolean {
    if (!this.pixelTier) return false;
    if (this.runtime.taint.value) {
      this.loseVision('PIXEL_TAINTED');
      return false;
    }
    return true;
  }

  /** Records whether requested pixels actually became model input. */
  private recordPixels(observation: AgentObservation): void {
    const pixels = observation.pixels;
    if (pixels === undefined) {
      this.loseVision(observation.pixelsWithheld ?? 'UNSUPPORTED_CAPABILITY');
      return;
    }
    this.visionInput = true;
    this.metrics.pixelBytes = Math.max(this.metrics.pixelBytes ?? 0, pixels.bytes);
    this.recordPolicy('vision.pixels', 'allowed');
  }

  /**
   * Records that requested pixels did not become model input.
   *
   * Every mode that also sends the tree degrades to it. `'only'` has nothing to
   * degrade to: continuing would answer a question about what the page presents
   * from the tree the caller deliberately excluded, so it fails instead.
   */
  private loseVision(code: VisionDegradation): void {
    if (this.visionDegraded !== code) {
      this.visionDegraded = code;
      this.recordPolicy('vision.pixels', 'denied', code);
    }
    if (this.options.vision !== 'only') return;
    throw new AgentError(
      'POLICY_DENIED',
      `${this.options.api} was called with vision: 'only', so the screenshot is its only ` +
        `evidence, but pixel evidence is unavailable (${code}); it will not answer from the ` +
        'semantic tree instead',
    );
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
    // Nothing of the tree reaches the request, so the per-call token ceiling
    // does not bind it. The configured ceiling still bounds the walk, and a
    // fuller node map means a better hit-test for the point that comes back.
    if (this.treeWithheld) return config.agent.maxObservationBytes;
    const overhead =
      tokenUpperBound(this.system) +
      this.ledger.bytes +
      INSTRUCTION_RESERVE +
      (this.pixelTier ? PIXEL_RESERVE : 0);
    const withinTokenCeiling = Math.max(1_024, config.limits.maxModelTokensPerCall - overhead);
    return Math.min(config.agent.maxObservationBytes, withinTokenCeiling);
  }

  /**
   * Performs one model call, retrying invalid output while budget and deadline
   * remain. Exhaustion is MODEL_OUTPUT_INVALID, never a guessed success.
   */
  async ask<Value>(request: {
    schemaName: string;
    /** Closed response grammar, or undefined for runner-validated text mode. */
    schema: JSONSchema7 | undefined;
    validate: (value: unknown) => ProtocolValidation<Value>;
    prompt: PromptInput;
  }): Promise<Value> {
    let repair: PromptInput['repair'] = request.prompt.repair;
    this.metrics.contextBytes = tokenUpperBound(this.runtime.agentContext ?? '');
    this.metrics.ledgerBytes = this.ledger.bytes;
    for (;;) {
      this.checkDeadline();
      this.consumeModelCall();
      const prompt = buildPrompt({
        ...request.prompt,
        ...(this.treeWithheld ? { withholdTree: true } : {}),
        ledger: this.ledger.text,
        ...(repair === undefined ? {} : { repair }),
      });
      // Pixels travel with the observation they were captured for, so the
      // image and the tree in one request always describe one revision.
      const images = imagesFor(request.prompt.observation);
      try {
        const result = await this.instrument(
          { kind: 'model', phase: 'agent.model', name: request.schemaName },
          () =>
            this.adapter.generate({
              system: this.system,
              prompt,
              ...(images === undefined ? {} : { images }),
              schemaName: request.schemaName,
              schema: request.schema,
              validate: request.validate,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              maxInputTokens: this.runtime.config.limits.maxModelTokensPerCall,
              signal: this.runtime.signal,
              timeoutMs: Math.max(1, this.deadline.remaining()),
            }),
          (generated) => ({
            count: generated.usage.inputTokens + generated.usage.outputTokens,
          }),
        );
        this.recordUsage(result.usage);
        return result.value;
      } catch (cause) {
        if (
          cause instanceof ModelOutputInvalidError &&
          this.metrics.modelCalls < this.options.maxModelCalls &&
          !this.deadline.expired()
        ) {
          this.recordSchemaRejection(request.schemaName);
          agentTrace(() => `${this.options.api} repair round: ${cause.explanation}`);
          repair = {
            issue: cause.explanation,
            rawText: cause.rawText,
          };
          continue;
        }
        throw cause;
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
    return this.instrument({ kind: 'driver', phase: 'agent.action', name }, body);
  }

  /** Records one rejected response payload as a child event. */
  recordSchemaRejection(name: string): void {
    this.runtime.steps.recordEvent({
      kind: 'schema',
      startedAt: timestamp(),
      durationMs: 0,
      status: 'failed',
      name,
      code: 'MODEL_OUTPUT_INVALID',
    });
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

  /** True once any driver action of this invocation has been dispatched. */
  get dispatched(): boolean {
    return this.metrics.actionSteps > 0;
  }

  /** True while the model-call budget and deadline still allow one more call. */
  canAsk(): boolean {
    return this.metrics.modelCalls < this.options.maxModelCalls && !this.deadline.expired();
  }

  /**
   * Records the judgment explanation that must survive a later failure, such
   * as the one `agent.assert` reports. The observation revision is recorded by
   * `observe()` itself.
   */
  note(details: { explanation?: string }): void {
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
      ...(this.visionInput ? { visionInput: true } : {}),
      ...(this.visionEscalated ? { visionEscalated: true } : {}),
      ...(this.treeWithheld ? { visionOnly: true } : {}),
      ...(this.visionDegraded !== undefined ? { visionDegraded: this.visionDegraded } : {}),
    });
  }

  private modelInfo(): StepModelInfo {
    const provenance = this.adapter.provenance;
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

/** The closed agent code set, derived from the one classification table. */
const AGENT_CODES = new Set<string>(Object.keys(CATEGORY_BY_CODE));

/**
 * Maps any runner error raised inside an invocation onto the closed agent code
 * set. Model prose can never select a code.
 */
export function toAgentError(cause: unknown): AgentError {
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

/** Trace fragment describing what pixel evidence an observation carried. */
function describePixels(observation: AgentObservation): string {
  if (observation.pixels !== undefined) {
    const { width, height, bytes, maskedRegionCount } = observation.pixels;
    return `, pixels ${width}x${height} ${bytes}B, ${maskedRegionCount} masked`;
  }
  return observation.pixelsWithheld === undefined
    ? ''
    : `, pixels withheld (${observation.pixelsWithheld})`;
}

/** Image parts for one request, derived from the observation it quotes. */
function imagesFor(observation: AgentObservation | undefined): readonly ModelImage[] | undefined {
  const pixels = observation?.pixels;
  if (pixels === undefined) return undefined;
  return [
    {
      data: pixels.data,
      mediaType: pixels.mediaType,
      width: pixels.width,
      height: pixels.height,
    },
  ];
}

function errorCode(cause: unknown): string {
  if (cause instanceof E2EError) return cause.code;
  return cause instanceof Error ? cause.name : 'ERROR';
}
