/**
 * One bounded agent invocation (spec 02-test-api.md, 10-determinism.md).
 *
 * Every `agent.*` call is a separate invocation with a fresh observation, an
 * explicit deadline, a model-call budget, and no shared model transcript.
 */

import type { StepExecutorContext } from './executor.ts';
import type { JSONSchema7 } from 'ai';
import type { AgentCacheContext } from '../cache/context.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { TargetSession, Observation } from '../backend/surface.ts';
import type { DebugTrace } from '../internal/debug.ts';
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
import type { VisionMode } from '../types.ts';
import { AgentError, toAgentError } from './error.ts';
import type { StepExecutor } from './executor.ts';
import { checkStepClock, instrumentPhase, retryingObserve, type PhaseSpec } from './phases.ts';

export { toAgentError };
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
  /** The step executor `agent.act()` dispatches to (RFC0001 layer 4). */
  readonly executor: StepExecutor;
  /**
   * True when the executor came from config rather than the built-in default.
   * A custom executor also judges `agent.assert` through the socket; the
   * default path keeps the optimized single-judgment tier.
   */
  readonly customExecutor: boolean;
  /** Chooses the model for a call; a vision call may use a pinned one. */
  readonly models: ModelRouter;
  readonly config: ResolvedConfig;
  /** The target this attempt runs on. */
  readonly target: StepExecutorContext['target'];
  /** Completed steps quoted as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted project context: config.agent.context then test/group agentContext. */
  readonly agentContext: string | undefined;
  readonly secrets: SecretResolver;
  /** The attempt's live redactor (SecretLedger); sees values the moment they exist. */
  readonly redact: (text: string) => string;
  /** Set once any secret is filled; the viewport stays pixel-tainted after. */
  readonly taint: { value: boolean };
  readonly artifacts: ArtifactSink;
  readonly signal: AbortSignal;
  /** The attempt's trace cache, or undefined when caching is off. */
  readonly cache?: AgentCacheContext;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
}

export interface InvocationOptions {
  /** Public API name, e.g. `agent.assert`. */
  readonly api: string;
  /** Caller's instruction, e.g. the target phrase, used for debug step labels. */
  readonly label?: string;
  /** Short task description placed in the system message. */
  readonly task: string;
  readonly timeoutMs: number;
  readonly maxModelCalls: number;
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
  /**
   * Whether this invocation asks for pixel evidence. Readable so a caller can
   * tell that comparing successive observation trees is meaningless here: an
   * animation the tree cannot see is still a change a vision call must judge.
   */
  pixelTier: boolean;

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

  /** Public API name of the method being run, e.g. `agent.assert`. */
  get api(): string {
    return this.options.api;
  }

  get engine(): LocatorEngine {
    return this.runtime.engine;
  }

  get session(): TargetSession {
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

  /** Runs one phase through the shared accounting core (see phases.ts). */
  private instrument<Value>(
    spec: Omit<PhaseSpec, 'api'>,
    body: () => Promise<Value>,
    detail?: (value: Value) => Partial<StepEvent>,
  ): Promise<Value> {
    return instrumentPhase(this.runtime, { ...spec, api: this.options.api }, body, detail);
  }

  /** Captures and redacts one fresh observation. */
  async observe(): Promise<AgentObservation> {
    this.checkDeadline();
    const pixels = this.pixelsRequested();
    const observation = await this.instrument(
      { kind: 'observation', phase: 'agent.observe' },
      async () => {
        const raw = await this.captureObservation(pixels);
        return prepareObservation(raw, {
          redact: this.runtime.redact,
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

  /** Captures one raw observation through the shared race-hardened path. */
  private captureObservation(pixels: boolean): Promise<Observation> {
    return retryingObserve({
      observe: (operation) => this.session.observe(operation, { pixels }),
      operation: () => this.operation(),
      guard: (cause) => this.checkDeadline(cause),
      signal: this.runtime.signal,
      api: this.options.api,
    });
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
   * degrade to: continuing would answer a question about what the screen presents
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
   * token limit binds first on a large screen. Deriving the budget from what the
   * rest of the request actually costs makes a big screen truncate visibly rather
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

  /**
   * Builds a backend operation context: `actionTimeout`, capped by this
   * invocation's deadline. Each backend call is bounded independently so one
   * hung observation cannot consume the invocation's whole clock.
   */
  operation(): ReturnType<LocatorEngine['operation']> {
    return this.runtime.engine.operation(
      Math.max(1, Math.min(this.runtime.config.actionTimeout, this.deadline.remaining())),
    );
  }

  /** Fails when the invocation deadline has elapsed (see checkStepClock). */
  checkDeadline(cause?: unknown): void {
    checkStepClock({
      signal: this.runtime.signal,
      deadline: this.deadline,
      api: this.options.api,
      timeoutMs: this.options.timeoutMs,
      ...(cause === undefined ? {} : { cause }),
    });
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
      ...(this.observationRevision !== undefined
        ? { observationRevision: this.observationRevision }
        : {}),
      ...(this.explanation !== undefined ? { explanation: this.explanation } : {}),
      ...(this.visionInput ? { visionInput: true } : {}),
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

