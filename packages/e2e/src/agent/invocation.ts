/**
 * One bounded agent invocation.
 *
 * Every `agent.*` call is a separate invocation with a fresh observation, an
 * explicit deadline, a model-call budget, and no shared model transcript.
 */

import type { StepExecutorContext } from './executor.ts';
import type { JSONSchema7 } from 'ai';
import type { AgentCacheContext } from '../cache/context.ts';
import type { ResolvedAgentConfig } from '../config/agent.ts';
import type { ResolvedApp, ResolvedConfig } from '../config/resolve.ts';
import type { TargetSession, Observation } from '../engine/surface.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { timestamp } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
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
import { AgentError } from './error.ts';
import { ModelUsage, tokenFields } from './usage.ts';
import type { ExecutorAttempt, StepExecutor } from './executor.ts';
import {
  boundedOperation,
  checkStepClock,
  instrumentPhase,
  recordPolicyEvent,
  retryingObserve,
  type PhaseSpec,
} from './phases.ts';
import {
  ModelOutputInvalidError,
  tokenUpperBound,
  type ModelAdapter,
  type ModelImage,
} from './model/adapter.ts';
import { pixelsForModel, prepareObservation, type AgentObservation } from './observation.ts';
import { observationByteBudget } from './observation-budget.ts';
import type { ProtocolValidation } from './protocol.ts';
import { POLICY_VERSION, buildPrompt, buildSystem, type PromptInput } from './prompts.ts';

/**
 * One configured agent as a call sees it: its resolved options, the executor
 * `act` dispatches to, the models its calls talk to, and the trusted context
 * its prompts open with.
 */
export interface AgentSelection {
  /** The agent's name in `agents`. */
  readonly name: string;
  readonly config: ResolvedAgentConfig;
  /** The step executor `agent.act()` dispatches to. */
  readonly executor: StepExecutor;
  /**
   * True when the executor came from config rather than the built-in default.
   * A custom executor also judges `agent.assert` through the socket; the
   * default path keeps the optimized single-judgment tier.
   */
  readonly customExecutor: boolean;
  /**
   * The adapter the judgment tier (`assert`, `waitFor`, `extract`) calls,
   * built on first use. It is the only model the runtime calls itself: `act`
   * goes through the executor, which brings its own. Config resolves `judge`
   * to the agent's `model` unless a judge of its own was configured.
   */
  readonly judge: () => ModelAdapter;
  /** Trusted project context: the agent's `context` then test/group agentContext. */
  readonly agentContext: string | undefined;
}

/** Attempt-scoped services one agent fixture needs. */
export interface AgentContext {
  readonly engine: LocatorEngine;
  readonly steps: StepRecorder;
  /**
   * The agent a call runs with: the one it names, else the test's pin, else
   * the run's. An unknown name is `INVALID_ARGUMENT`.
   */
  readonly select: (name: string | undefined) => AgentSelection;
  readonly config: ResolvedConfig;
  /** The target this attempt runs on. */
  readonly target: StepExecutorContext['target'];
  /** The app the target drives: base URL and origin policy for navigation and secret fills. */
  readonly app: ResolvedApp;
  /** The attempt's identity, end signal, and executor scratch memory. */
  readonly attempt: ExecutorAttempt;
  /**
   * Completed steps quoted as prior context for `agent.act`; serial members
   * see the whole group. A judgment never reads them: the judge sees the
   * instruction and the current screen, not the acting agent's account.
   */
  readonly priorSteps: () => readonly StepRecord[];
  readonly secrets: SecretResolver;
  /** The attempt's live redactor (SecretLedger); sees values the moment they exist. */
  readonly redact: (text: string) => string;
  /** Set once any secret is filled; the viewport stays pixel-tainted after. */
  readonly taint: { value: boolean };
  readonly artifacts: ArtifactSink;
  /** The attempt's trace cache, or undefined when caching is off. */
  readonly cache?: AgentCacheContext;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
}

export interface InvocationOptions {
  /** Public API name, e.g. `agent.assert`. */
  readonly api: string;
  /** The configured agent the call named, if any. */
  readonly agent?: string | undefined;
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
   * call.
   */
  readonly vision: VisionMode;
}

/**
 * Output ceiling for one judgment. A reasoning model spends this on its
 * hidden reasoning before the answer, so the cap has to leave room for both.
 */
const MAX_OUTPUT_TOKENS = 8192;

/** Model-call accounting plus observation metrics for one invocation; a judgment carries no ledger. */
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
   * Trusted system message: runner policy, then project context. Measured
   * once, because it is the fixed part of every request's token budget.
   */
  private readonly system: string;

  private readonly usage = new ModelUsage();
  private observationRevision: string | undefined;
  private explanation: string | undefined;
  private visionInput = false;
  private visionDegraded: VisionDegradation | undefined;
  /**
   * Whether this invocation asks for pixel evidence. Readable so a caller can
   * tell that comparing successive observation trees is meaningless here: an
   * animation the tree cannot see is still a change a vision call must judge.
   */
  readonly pixelTier: boolean;
  /** Byte size of the invariant system message, measured once. */
  private readonly systemBytes: number;
  /** The agent this invocation runs with. */
  readonly agent: AgentSelection;

  constructor(
    private readonly runtime: AgentContext,
    private readonly options: InvocationOptions,
  ) {
    this.agent = runtime.select(options.agent);
    this.deadline = runtime.engine.deadline(options.timeoutMs);
    this.pixelTier = options.vision === true || options.vision === 'only';
    this.system = buildSystem(options.task, this.agent.agentContext);
    this.systemBytes = tokenUpperBound(this.system);
  }

  get session(): TargetSession {
    return this.runtime.engine.session;
  }

  /** The judge: a judgment is the only model call an invocation makes. */
  private get adapter(): ModelAdapter {
    return this.agent.judge();
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
    return observation;
  }

  /** Captures one raw observation through the shared race-hardened path. */
  private captureObservation(pixels: boolean): Promise<Observation> {
    return retryingObserve({
      observe: (operation) => this.session.observe(operation, { pixels }),
      operation: () => this.operation(),
      guard: (cause) => this.checkDeadline(cause),
      signal: this.runtime.engine.signal,
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
    const outcome = pixelsForModel(observation, this.runtime.taint.value);
    if ('withheld' in outcome) {
      this.loseVision(outcome.withheld);
      return;
    }
    this.visionInput = true;
    this.metrics.pixelBytes = Math.max(this.metrics.pixelBytes ?? 0, outcome.pixels.data.byteLength);
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

  /** Bytes one observation may contribute to a request; see `observationByteBudget`. */
  private observationByteBudget(): number {
    const { config } = this.runtime;
    // Nothing of the tree reaches the request, so the per-call token ceiling
    // does not bind it. The configured ceiling still bounds the walk, and a
    // fuller node map means a better hit-test for the point that comes back.
    if (this.treeWithheld) return this.agent.config.maxObservationBytes;
    return observationByteBudget(
      {
        maxObservationBytes: this.agent.config.maxObservationBytes,
        maxModelTokensPerCall: config.limits.maxModelTokensPerCall,
      },
      { fixedBytes: this.systemBytes, pixels: this.pixelTier },
    );
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
    this.metrics.contextBytes = tokenUpperBound(this.agent.agentContext ?? '');
    for (;;) {
      this.checkDeadline();
      this.consumeModelCall();
      const prompt = buildPrompt({
        ...request.prompt,
        ...(this.treeWithheld ? { withholdTree: true } : {}),
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
              providerOptions: this.agent.config.providerOptions,
              signal: this.runtime.engine.signal,
              timeoutMs: Math.max(1, this.deadline.remaining()),
            }),
          (generated) => ({
            count: this.usage.record(generated.usage),
            ...tokenFields(generated.usage),
          }),
        );
        return result.value;
      } catch (cause) {
        if (
          cause instanceof ModelOutputInvalidError &&
          this.metrics.modelCalls < this.options.maxModelCalls &&
          !this.deadline.expired()
        ) {
          this.recordSchemaRejection(request.schemaName);
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
    recordPolicyEvent(this.runtime.steps, name, decision, code);
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
   * Builds an engine operation context: `actionTimeout`, capped by this
   * invocation's deadline. Each engine call is bounded independently so one
   * hung observation cannot consume the invocation's whole clock.
   */
  operation(): ReturnType<LocatorEngine['operation']> {
    return boundedOperation(this.runtime.engine, this.runtime.config.actionTimeout, this.deadline);
  }

  /** Fails when the invocation deadline has elapsed (see checkStepClock). */
  checkDeadline(cause?: unknown): void {
    checkStepClock({
      signal: this.runtime.engine.signal,
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
    return this.usage.report({ ...provenance, policyVersion: POLICY_VERSION }, this.metrics.modelCalls);
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

