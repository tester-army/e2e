/**
 * What one step has seen of the screen, and how it looks again.
 *
 * The feed owns every capture of a step: the settle that reads an action's
 * result after its effect, the ring of recent observations an id is resolved
 * against, the pixel decision (masking proven, viewport untainted), and the
 * executor's redacted view of a capture. Nothing else in the step observes
 * the engine; the dispatcher and the pixel tier ask the feed.
 */

import type { SemanticNode } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import type { StepAgentDetails, VisionDegradation } from '../run/steps.ts';
import { describeTarget } from './actions.ts';
import { relocateDescriptor } from '../cache/relocate.ts';
import { AgentError } from './error.ts';
import type { ExecutorObservation, ExecutorObserveOptions, ExecutorTarget } from './executor.ts';
import type { AgentContext } from './invocation.ts';
import {
  changeShape,
  isTransitionalObservation,
  observationShape,
  pixelsForModel,
  prepareObservation,
  observationDetail,
  projectTree,
  settleObservation,
  type AgentObservation,
  type SemanticAgentObservation,
} from './observation.ts';
import { observationByteBudget } from './observation-budget.ts';
import type { OperationQueue } from './operation-queue.ts';
import { instrumentPhase, recordPolicyEvent, retryingObserve } from './phases.ts';
import type { StepAccounting } from './step-accounting.ts';

/**
 * Observations kept for resolving an id the newest one no longer carries.
 * A turn that batches actions addresses the screen it saw, while every
 * action's own look re-observes; on an engine that mints ids per observation
 * (a device), each look renumbers the tree. A few looks back is as far as one
 * turn can reach.
 */
const MAX_RECENT_OBSERVATIONS = 8;
/** Screens whose text the step keeps for telling a screen-derived typed value from a composed one. */
const MAX_SEEN_SCREENS = 64;

export interface ObservationFeedOptions {
  /** The agent's observation byte ceiling, clamped per capture by the token limit. */
  readonly maxObservationBytes: number;
}

export class ObservationFeed {
  private newest: AgentObservation | undefined;
  /** A cache probe may supply the executor's first look, once, before any action. */
  private opening: AgentObservation | undefined;
  private semanticHistory = true;
  /** The text of every distinct screen the step has looked at, oldest first, bounded. */
  private readonly seen: string[] = [];
  /** The newest observations of the step, oldest first; see MAX_RECENT_OBSERVATIONS. */
  private readonly recent: SemanticAgentObservation[] = [];
  /**
   * The screen shape the newest committed action was resolved against, kept
   * until the next settled observation has waited for the screen to leave it.
   * Armed by actions whose effect shows in the tree; a secret fill leaves no
   * visible trace and a scroll moves nothing the tree records, so neither
   * arms it. Without this, the observation after a tap on a link reads the
   * old page, stable and wrong, and the model repairs what already worked.
   */
  private pendingChange: string | undefined;
  /** The change wait the pending action asked for; undefined takes the default. */
  private pendingChangeWaitMs: number | undefined;
  /** The last pixel decision recorded on this step: `allowed`, or the withheld reason. */
  private pixelsDecided: string | undefined;
  /** Why requested pixels did not become model input, when they did not. */
  private visionDegraded: VisionDegradation | undefined;
  /** True once pixels this feed cleared were handed to the executor as model input. */
  private pixelsSent = false;

  constructor(
    private readonly runtime: AgentContext,
    private readonly accounting: StepAccounting,
    private readonly queue: OperationQueue,
    private readonly options: ObservationFeedOptions,
  ) {}

  /** The newest observation of the step, if any was captured. */
  get latest(): AgentObservation | undefined {
    return this.newest;
  }

  /** A trace may only describe a step observed with semantic evidence throughout. */
  get traceEligible(): boolean {
    return this.semanticHistory;
  }

  /** The text of the screens this step has seen so far, oldest first; what a typed value is checked against. */
  seenScreenText(): readonly string[] {
    return this.seen;
  }

  /** The newest observation, which an action addresses; before the first look there is nothing to address. */
  requireLatest(): AgentObservation {
    if (this.newest === undefined) {
      throw new AgentError('LOCATOR_NOT_FOUND', 'no observation has been captured yet; observe before acting');
    }
    return this.newest;
  }

  /**
   * Captures cache evidence in queue order. Before any action, its completed
   * capture can serve the executor's first look once. Every later capture
   * clears that handoff before starting, even when the later capture fails.
   */
  probe(settle: boolean): Promise<AgentObservation> {
    return this.queue.run(async () => {
      const observation = await this.observeNow(settle, false);
      if (this.accounting.metrics.actionSteps === 0) this.opening = observation;
      return observation;
    });
  }

  /** The executor-facing observe: the options checked before anything is captured, then one settled look, viewed. */
  async observe(options: ExecutorObserveOptions = {}): Promise<ExecutorObservation> {
    if (options === null || typeof options !== 'object') {
      throw new TestError('INVALID_ARGUMENT', 'observe options must be an object');
    }
    return this.queue.run(async () => {
      this.accounting.checkpoint();
      const pixels = options.pixels === true;
      const opening = this.opening;
      this.opening = undefined;
      const reusable = opening !== undefined && opening === this.newest && this.accounting.metrics.actionSteps === 0 &&
        (!pixels || opening.pixels !== undefined);
      return this.view(reusable ? opening : await this.observeNow(true, pixels), options);
    });
  }

  /** Projects one capture, including its permitted screenshot whenever semantic evidence is unavailable. */
  private view(observation: AgentObservation, options: ExecutorObserveOptions): ExecutorObservation {
    const metadata = {
      revision: observation.revision,
      viewport: observation.viewport,
      ...(observation.path === undefined ? {} : { path: observation.path }),
    };
    const pixels = options.pixels === true || observation.kind === 'pixels' ? this.pixelsFor(observation) : {};
    if (observation.kind === 'pixels') {
      return { ...metadata, text: observation.text, treeUnavailable: true, truncated: true, ...pixels };
    }
    return {
      ...metadata,
      text: observation.text,
      truncated: observation.truncated,
      ...(options.tree === true ? { tree: projectTree(observation.tree, this.runtime.redact) } : {}),
      ...pixels,
    };
  }

  /**
   * Arms the change wait: the next settled observation waits for the screen
   * to leave the newest observation's shape, for the default two seconds or
   * the given brief window.
   */
  armChange(waitMs?: number): void {
    if (this.newest === undefined) return;
    this.pendingChange = changeShape(this.newest);
    this.pendingChangeWaitMs = waitMs;
  }

  /**
   * Resolves an executor target against the newest observation. An id the
   * newest observation no longer carries, but a recent one did, is re-found
   * in the newest one by its descriptor: a turn that batches actions keeps
   * addressing the screen it saw while each action's own look re-observes,
   * and an engine that mints ids per observation renumbers the tree between
   * them. Exactly one match, or the id counts as gone.
   */
  resolve(target: ExecutorTarget): { node: SemanticNode; observation: SemanticAgentObservation } {
    if (typeof target?.id !== 'string' || target.id === '') {
      throw new TestError('INVALID_ARGUMENT', 'action target must be { id: string }');
    }
    const id = target.id.replace(/^#/, '');
    const latest = this.requireLatest();
    if (latest.kind === 'pixels') {
      throw new AgentError('LOCATOR_NOT_FOUND', 'semantic capture is unavailable; previous node ids are no longer valid, so use the current screenshot');
    }
    const node = latest.nodes.get(id) ?? this.refound(id, latest);
    if (node === undefined) {
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        `node #${id} is not on the current screen (observation ${latest.revision}); it was removed or never existed`,
      );
    }
    return { node, observation: latest };
  }

  /**
   * Re-finds a node that went stale: one fresh capture, then the trace
   * recorder's own descriptor matching (`cache/relocate.ts`) against it,
   * exactly one match or nothing. The capture is taken directly rather than
   * through the queued observe: this runs inside a queued action body, and a
   * queued observation would wait on its own caller.
   */
  async relocate(stale: SemanticNode): Promise<{ node: SemanticNode; observation: SemanticAgentObservation } | undefined> {
    const options = { redact: this.runtime.redact };
    const descriptor = describeTarget(stale, options.redact);
    if (descriptor === undefined) return undefined;
    this.accounting.checkpoint();
    const observation = await instrumentPhase(
      this.runtime,
      { api: this.accounting.api, kind: 'observation', phase: 'agent.observe', name: 'relocate' },
      () => this.capture(false),
      observationDetail,
    );
    this.publish(observation);
    if (observation.kind === 'pixels') return undefined;
    const relocated = relocateDescriptor(descriptor, observation.nodes, options);
    if (relocated.kind !== 'found') return undefined;
    const node = observation.nodes.get(relocated.id);
    return node === undefined ? undefined : { node, observation };
  }

  /** The step's pixel record for the report. */
  visionReport(): Pick<StepAgentDetails, 'visionInput' | 'visionDegraded'> {
    return {
      ...(this.pixelsSent ? { visionInput: true } : {}),
      ...(this.visionDegraded === undefined ? {} : { visionDegraded: this.visionDegraded }),
    };
  }

  /** One recorded observation; when `settle`, the captures loop inside it. */
  private async observeNow(settle: boolean, pixels: boolean): Promise<AgentObservation> {
    this.opening = undefined;
    this.accounting.checkpoint();
    // A tainted viewport never captures pixels: the engine would mask what it
    // knows about, and the secret may be anywhere on screen by now.
    const capturePixels = pixels && !this.runtime.taint.value;
    // A settled look consumes the pending change: it waits for the screen to
    // leave the pre-action shape once, and later looks read the screen as is.
    const changedFrom = settle ? this.pendingChange : undefined;
    const changeWaitMs = settle ? this.pendingChangeWaitMs : undefined;
    if (settle) {
      this.pendingChange = undefined;
      this.pendingChangeWaitMs = undefined;
    }
    const observation = await instrumentPhase(
      this.runtime,
      { api: this.accounting.api, kind: 'observation', phase: 'agent.observe' },
      () =>
        settle
          ? settleObservation(
              () => this.capture(capturePixels),
              observationShape,
              {
                remainingMs: () => this.accounting.remainingMs(),
                // The step's own hard stop must interrupt a settle sleep too —
                // the attempt signal alone would let settling outlive the step
                // by one poll interval.
                signal: this.accounting.signal,
              },
              {
                changedFrom,
                changeWaitMs,
                changeShapeOf: changeShape,
                transitional: isTransitionalObservation,
              },
            )
          : this.capture(capturePixels),
      observationDetail,
    );
    this.publish(observation);
    return observation;
  }

  /** Makes an observation the newest, remembers it among the recent ones, and books its size. */
  private publish(observation: AgentObservation): void {
    this.newest = observation;
    if (observation.kind === 'pixels') this.recent.length = 0;
    else this.recent.push(observation);
    if (this.recent.length > MAX_RECENT_OBSERVATIONS) this.recent.shift();
    if (this.seen[this.seen.length - 1] !== observation.text) {
      this.seen.push(observation.text);
      if (this.seen.length > MAX_SEEN_SCREENS) this.seen.shift();
    }
    const metrics = this.accounting.metrics;
    metrics.observationBytes = Math.max(metrics.observationBytes, observation.bytes);
  }

  /** One raw observation capture: retried at the engine, then redacted and bounded. */
  private async capture(pixels: boolean): Promise<AgentObservation> {
    this.opening = undefined;
    const raw = await retryingObserve({
      observe: (operation) => this.runtime.engine.session.observe(operation, {
        pixels,
        pixelFallback: !this.runtime.taint.value,
      }),
      operation: () => this.accounting.operation(),
      guard: (cause) => this.accounting.checkpoint(cause),
      signal: this.runtime.engine.signal,
      api: this.accounting.api,
    });
    if (raw.kind === 'pixels') {
      this.semanticHistory = false;
      this.newest = undefined;
      this.recent.length = 0;
    }
    const prepared = prepareObservation(raw, {
      redact: this.runtime.redact,
      maxBytes: this.byteBudget(pixels || raw.kind === 'pixels'),
      pixelsAllowed: !this.runtime.taint.value,
    });
    return prepared;
  }

  /**
   * Bytes one act observation may contribute to a model turn, clamped like a
   * judgment's. The loop's history grows past what any one observation costs,
   * so the fixed part counted here is what every turn resends: the project
   * context and the prior-step ledger.
   */
  private byteBudget(pixels: boolean): number {
    const metrics = this.accounting.metrics;
    return observationByteBudget(
      {
        maxObservationBytes: this.options.maxObservationBytes,
        maxModelTokensPerCall: this.runtime.config.limits.maxModelTokensPerCall,
      },
      { fixedBytes: metrics.contextBytes + metrics.ledgerBytes, pixels },
    );
  }

  /**
   * Pixels for a caller that asked for them, or the reason they are withheld —
   * the same decision the judgment tier makes, recorded as a policy event
   * whenever it changes within the step.
   */
  private pixelsFor(observation: AgentObservation): Pick<ExecutorObservation, 'pixels' | 'pixelsWithheld'> {
    const outcome = pixelsForModel(observation, this.runtime.taint.value);
    if ('withheld' in outcome) {
      this.recordPixelDecision('denied', outcome.withheld);
      this.visionDegraded = outcome.withheld;
      if (observation.kind === 'pixels') {
        throw new TestError('UNSUPPORTED_CAPABILITY', 'semantic capture is unavailable and its screenshot is no longer permitted');
      }
      return { pixelsWithheld: outcome.withheld };
    }
    this.recordPixelDecision('allowed');
    this.pixelsSent = true;
    const metrics = this.accounting.metrics;
    metrics.pixelBytes = Math.max(metrics.pixelBytes ?? 0, outcome.pixels.data.byteLength);
    return { pixels: outcome.pixels };
  }

  private recordPixelDecision(decision: 'allowed' | 'denied', code?: string): void {
    const key = code ?? decision;
    if (this.pixelsDecided === key) return;
    this.pixelsDecided = key;
    recordPolicyEvent(this.runtime.steps, 'vision.pixels', decision, code);
  }

  /** The newest node matching the descriptor of what `id` named in a recent observation, if exactly one. */
  private refound(id: string, latest: SemanticAgentObservation): SemanticNode | undefined {
    let earlier: SemanticNode | undefined;
    for (let index = this.recent.length - 1; index >= 0 && earlier === undefined; index -= 1) {
      earlier = this.recent[index]!.nodes.get(id);
    }
    if (earlier === undefined) return undefined;
    const options = { redact: this.runtime.redact };
    const descriptor = describeTarget(earlier, options.redact);
    if (descriptor === undefined) return undefined;
    const relocated = relocateDescriptor(descriptor, latest.nodes, options);
    return relocated.kind === 'found' ? latest.nodes.get(relocated.id) : undefined;
  }
}
