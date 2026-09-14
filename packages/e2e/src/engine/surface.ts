/**
 * The internal session surface the harness consumes for one attempt. It is
 * produced only by `createEngineSession` (the engine-to-session adapter) and
 * is never part of the public API: the locator engine, the agent tiers, and
 * the attempt executor program against it so that revision minting, staleness
 * checks, and capability gating exist exactly once.
 *
 * Re-exports the contract vocabulary so internal modules import one path.
 */

import type { Momentum, ScrollDirection } from '../types.ts';
import type {
  LocatorAction,
  LocatorActionKind,
  LocatorExpression,
  NodeRef,
  ObservationPixels,
  OperationContext,
  SemanticNode,
  ViewportPoint,
} from './contract.ts';
import type { EngineObserveOptions, EngineState, VideoSegment } from './index.ts';

export type * from './contract.ts';
export { EngineError } from './contract.ts';
export type { EngineObserveOptions, EngineState, VideoSegment } from './index.ts';

/**
 * The agent's action grammar, by verb. A session derives which verbs its
 * engine can honor from the action kinds the engine declared, so the agent
 * offers the model exactly that vocabulary. The vision-located tap is not a
 * verb of its own: it rides `tap` when the located point sits on a node the
 * tree lists, and `tapAt` when it does not.
 */
export type GrammarVerb = 'tap' | 'type' | 'typeSecret' | 'press' | 'select' | 'scroll' | 'navigate' | 'tapAt';

export interface Observation {
  /** Where the surface was when captured, when the platform has a location. */
  readonly location?: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly pixels?: ObservationPixels;
  readonly tree: SemanticNode;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
  /**
   * What the engine masked against what it saw. Pixel completeness is judged
   * downstream from these counts: fewer masked regions than secure nodes
   * withholds the pixels and keeps the tree.
   */
  readonly redaction: {
    readonly secureNodeCount: number;
    readonly maskedRegionCount: number;
  };
}

export interface SessionApp {
  /** Opens the app at one resolved URL. */
  open(url: string, operation: OperationContext): Promise<void>;
  /** Navigates back once. */
  back(operation: OperationContext): Promise<void>;
  /** Recreates the app context without clearing persisted state; shows nothing until `open`. */
  restart(operation: OperationContext): Promise<void>;
  /** Clears persisted client state and recreates the context; shows nothing until `open`. */
  reset(operation: OperationContext): Promise<void>;
}

export interface SessionArtifacts {
  /** Captures a redacted screenshot and returns an artifact-relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string>;
  /** Starts trace recording. */
  startTrace?(operation: OperationContext): Promise<void>;
  /** Stops trace recording and returns the artifact-relative path, or every segment written, in order. */
  stopTrace?(operation: OperationContext): Promise<string | readonly string[]>;
  /** Starts video recording. */
  startVideo?(operation: OperationContext): Promise<void>;
  /** Stops video recording and returns the segments written, in order. */
  stopVideo?(operation: OperationContext): Promise<readonly VideoSegment[]>;
}

export interface TargetSession {
  /** Grammar verbs the engine can honor, derived from its declared action kinds and hooks. */
  readonly verbs: ReadonlySet<GrammarVerb>;
  /** Action kinds the engine declared for `perform`; empty without the actions capability. */
  readonly actions: ReadonlySet<LocatorActionKind>;
  /** Captures one atomic agent observation; the harness redacts it downstream. */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<Observation>;
  /** Resolves immediately; the runner owns query polling and strictness. */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly NodeRef[]>;
  /** Reads one node from the resolution that minted its ref. */
  read(ref: NodeRef, operation: OperationContext): Promise<SemanticNode>;
  /** Performs exactly one action on a located or observed node. */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void>;
  /**
   * Performs a viewport-level swipe: `perform(root, swipe)` on the observation
   * root, observing first when no observation has named it yet.
   */
  swipe(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    operation: OperationContext,
  ): Promise<void>;
  /** Taps one viewport point, in CSS pixels, with no node behind it. */
  tapAt(point: ViewportPoint, operation: OperationContext): Promise<void>;
  readonly app: SessionApp;
  readonly artifacts: SessionArtifacts;
  /** Captures immutable app state for a session envelope. */
  captureState?(operation: OperationContext): Promise<EngineState>;
  /** Replaces current app state with an immutable captured state. */
  restoreState?(state: EngineState, operation: OperationContext): Promise<void>;
  /** Ends the attempt's isolation within the operation's budget. Idempotent. */
  close(operation: OperationContext): Promise<void>;
}
