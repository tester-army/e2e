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
import { relocateDescriptor } from '../cache/relocate.ts';
import { TestError } from '../internal/errors.ts';
import { isEditable } from '../internal/roles.ts';
import type { StepAgentDetails, VisionDegradation } from '../run/steps.ts';
import { describeTarget } from './actions.ts';
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
  type PendingChange,
  type SemanticAgentObservation,
} from './observation.ts';
import { observationByteBudget } from './observation-budget.ts';
import type { OperationQueue } from './operation-queue.ts';
import { instrumentPhase, recordPolicyEvent, retryingObserve } from './phases.ts';
import { HELD_STILL_MS, type SettleMode } from './settle-policy.ts';
import type { StepAccounting } from './step-accounting.ts';

/**
 * Observations kept for resolving an id the newest one no longer carries.
 * A turn that batches actions addresses the screen it saw, while every
 * action's own look re-observes; on an engine that mints ids per observation
 * (a device), each look renumbers the tree. A few looks back is as far as one
 * turn can reach.
 */
const MAX_RECENT_OBSERVATIONS = 8;
/**
 * Strings the screens of a step showed, kept for telling a typed value read
 * off the screen from one the model composed (`derived.ts`): one per node,
 * the oldest dropped first past this many.
 */
const MAX_SHOWN_TEXTS = 4_096;

/** A target resolved to a node of the observation it was found in. */
export interface Resolved {
  readonly node: SemanticNode;
  readonly observation: SemanticAgentObservation;
}

/** What a target names on the newest screen: the id as the screen lists it, the node or nothing, and the screen looked at. */
export interface Lookup {
  readonly id: string;
  readonly node: SemanticNode | undefined;
  readonly observation: SemanticAgentObservation;
}

export interface ObservationFeedOptions {
  /** The agent's observation byte ceiling, clamped per capture by the token limit. */
  readonly maxObservationBytes: number;
}

export class ObservationFeed {
  private newest: AgentObservation | undefined;
  /** A cache probe may supply the executor's first look, once, before any action. */
  private opening: AgentObservation | undefined;
  private semanticHistory = true;
  /** What the step's screens have shown, one string per node, oldest first; see MAX_SHOWN_TEXTS. */
  private readonly shown = new Set<string>();
  /** The newest observations of the step, oldest first; see MAX_RECENT_OBSERVATIONS. */
  private readonly recent: SemanticAgentObservation[] = [];
  /**
   * The screen shape the newest committed action was resolved against, with
   * the window its settle policy allows, kept until the next settled
   * observation has waited for the screen to leave it. Armed by actions whose
   * effect shows in the tree (`SETTLE_AFTER`); a secret fill is masked out
   * of every capture, so it arms nothing. Without this, the observation after
   * a tap on a link reads the old page, stable and wrong, and the model
   * repairs what already worked.
   */
  private pendingChange: PendingChange | undefined;
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

  /** What the step's screens have shown so far, one string per node; what a typed value is checked against. */
  shownText(): ReadonlySet<string> {
    return this.shown;
  }

  /** True once a screenshot went to the model in this step; text drawn in it is not in `shownText`. */
  get pixelsShown(): boolean {
    return this.pixelsSent;
  }

  /** The newest observation, which an action addresses; before the first look there is nothing to address. */
  requireLatest(): AgentObservation {
    if (this.newest === undefined) {
      throw new AgentError('LOCATOR_NOT_FOUND', 'no observation has been captured yet; observe before acting');
    }
    return this.newest;
  }

  /**
   * Captures cache evidence in queue order, settled as far as `mode` asks.
   * Before any action, its completed capture can serve the executor's first
   * look once. Every later capture clears that handoff before starting, even
   * when the later capture fails.
   */
  probe(mode: SettleMode): Promise<AgentObservation> {
    return this.queue.run(async () => {
      const observation = await this.observeNow(mode, false);
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
      return this.view(reusable ? opening : await this.observeNow('held-still', pixels), options);
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
   * Arms the change wait: the next settled observation waits up to `waitMs`
   * for the screen to leave the newest observation's shape. Nothing is armed
   * on a screen without a comparable shape.
   */
  armChange(waitMs: number): void {
    if (this.newest === undefined) return;
    const shape = changeShape(this.newest);
    this.pendingChange = shape === undefined ? undefined : { shape, waitMs };
  }

  /**
   * Resolves an executor target against the newest observation. An id the
   * newest observation no longer carries, but a recent one did, is re-found
   * in the newest one by its descriptor: a turn that batches actions keeps
   * addressing the screen it saw while each action's own look re-observes,
   * and an engine that mints ids per observation renumbers the tree between
   * them. Exactly one match, or the id counts as gone.
   */
  resolve(target: ExecutorTarget): Resolved {
    const { id, node, observation } = this.lookup(target);
    if (node === undefined) throw nodeGone(id, observation);
    return { node, observation };
  }

  /**
   * The node a target names on the newest screen, if the screen still lists
   * it or its descriptor re-finds it; the screen must list nodes at all. The
   * id is the target's without the `#` the listing prefixes, which a model
   * copies now and then. A caller with its own way of re-finding a lost node
   * (`scroll-target.ts`) starts here.
   */
  lookup(target: ExecutorTarget): Lookup {
    if (typeof target?.id !== 'string' || target.id === '') {
      throw new TestError('INVALID_ARGUMENT', 'action target must be { id: string }');
    }
    const id = target.id.replace(/^#/, '');
    const latest = this.requireLatest();
    if (latest.kind === 'pixels') {
      throw new AgentError('LOCATOR_NOT_FOUND', 'semantic capture is unavailable; previous node ids are no longer valid, so use the current screenshot');
    }
    return { id, node: latest.nodes.get(id) ?? this.refound(id, latest), observation: latest };
  }

  /** What `id` named in the most recent observation that carried it. */
  lastSeen(id: string): Resolved | undefined {
    for (let index = this.recent.length - 1; index >= 0; index -= 1) {
      const observation = this.recent[index]!;
      const node = observation.nodes.get(id);
      if (node !== undefined) return { node, observation };
    }
    return undefined;
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

  /** One recorded observation, settled as far as `mode` asks. */
  private async observeNow(mode: SettleMode, pixels: boolean): Promise<AgentObservation> {
    this.opening = undefined;
    this.accounting.checkpoint();
    // A tainted viewport never captures pixels: the engine would mask what it
    // knows about, and the secret may be anywhere on screen by now.
    const capturePixels = pixels && !this.runtime.taint.value;
    const observation = await instrumentPhase(
      this.runtime,
      { api: this.accounting.api, kind: 'observation', phase: 'agent.observe' },
      () => this.captureSettled(mode, capturePixels),
      observationDetail,
    );
    this.publish(observation);
    return observation;
  }

  /**
   * One capture settled as far as `mode` asks. A raw look reads the screen
   * as it is. A settled look consumes the pending change: it waits for the
   * screen to leave the pre-action shape once, so later looks read the screen
   * as is; held still, it then proves the new shape holds for a beat, while
   * after-change reads the first post-change capture, which is all a fill's
   * own field needs.
   */
  private captureSettled(mode: SettleMode, pixels: boolean): Promise<AgentObservation> {
    if (mode === 'raw') return this.capture(pixels);
    const changedFrom = this.pendingChange;
    this.pendingChange = undefined;
    return settleObservation(
      () => this.capture(pixels),
      observationShape,
      {
        remainingMs: () => this.accounting.remainingMs(),
        // The step's own hard stop must interrupt a settle sleep too: the
        // attempt signal alone would let settling outlive the step by one
        // poll interval.
        signal: this.accounting.signal,
      },
      {
        changedFrom,
        stableWaitMs: mode === 'held-still' ? HELD_STILL_MS : 0,
        changeShapeOf: changeShape,
        transitional: isTransitionalObservation,
      },
    );
  }

  /** Makes an observation the newest, remembers it among the recent ones, and books its size. */
  private publish(observation: AgentObservation): void {
    this.newest = observation;
    if (observation.kind === 'pixels') this.recent.length = 0;
    else this.recent.push(observation);
    if (this.recent.length > MAX_RECENT_OBSERVATIONS) this.recent.shift();
    if (observation.kind === 'semantic') this.noteShown(observation);
    const metrics = this.accounting.metrics;
    metrics.observationBytes = Math.max(metrics.observationBytes, observation.bytes);
  }

  /**
   * Remembers what a screen displayed: the name and text of every node but
   * those that echo input (an editable field, whose name is its value or its
   * placeholder example; any node carrying a value) and the wrappers that
   * restate a field, which some platforms name after the field they hold.
   */
  private noteShown(observation: SemanticAgentObservation): void {
    for (const node of observation.nodes.values()) {
      if (echoesInput(node) || (node.children ?? []).some(echoesInput)) continue;
      for (const text of [node.name, node.text]) {
        if (text !== undefined && text !== '') this.shown.add(text);
      }
    }
    for (const oldest of this.shown) {
      if (this.shown.size <= MAX_SHOWN_TEXTS) break;
      this.shown.delete(oldest);
    }
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
    const earlier = this.lastSeen(id)?.node;
    if (earlier === undefined) return undefined;
    const options = { redact: this.runtime.redact };
    const descriptor = describeTarget(earlier, options.redact);
    if (descriptor === undefined) return undefined;
    const relocated = relocateDescriptor(descriptor, latest.nodes, options);
    return relocated.kind === 'found' ? latest.nodes.get(relocated.id) : undefined;
  }

}

/** A node whose name or text is what was put into it, not what the screen says. */
function echoesInput(node: SemanticNode): boolean {
  return isEditable(node) || node.value !== undefined;
}

/** The error for a target id the newest screen no longer lists. */
export function nodeGone(id: string, latest: SemanticAgentObservation): AgentError {
  return new AgentError(
    'LOCATOR_NOT_FOUND',
    `node #${id} is not on the current screen (observation ${latest.revision}); it was removed or never existed`,
  );
}
