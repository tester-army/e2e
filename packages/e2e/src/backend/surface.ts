/**
 * The internal session surface the harness consumes for one attempt. It is
 * produced only by `createBackendSession` (the backend-to-session adapter) and
 * is never part of the public API: the locator engine, the agent tiers, and
 * the attempt executor program against it so that revision minting, staleness
 * checks, and capability gating exist exactly once.
 *
 * Re-exports the contract vocabulary so internal modules import one path.
 */

import type { Momentum, ScrollDirection } from '../types.ts';
import type {
  LocatorAction,
  LocatorExpression,
  NodeRef,
  ObservationPixels,
  OperationContext,
  SemanticNode,
} from './contract.ts';
import type { BackendObserveOptions, BackendState } from './index.ts';

export type * from './contract.ts';
export { BackendError } from './contract.ts';
export type { BackendObserveOptions, BackendState } from './index.ts';

/**
 * The agent's action grammar, by verb. A session declares which verbs its
 * backend can honor so the agent offers the model exactly that vocabulary.
 */
export type GrammarVerb = 'tap' | 'type' | 'typeSecret' | 'press' | 'select' | 'scroll' | 'navigate';

export interface Observation {
  /** Location captured with this tree, when the backend can provide it. */
  readonly url?: string;
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
   * What the backend masked against what it saw. Pixel completeness is judged
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
  /** Recreates the app context without clearing persisted state. */
  restart(operation: OperationContext): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState(operation: OperationContext): Promise<void>;
}

export interface SessionArtifacts {
  /** Captures a redacted screenshot and returns an artifact-relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string>;
  /** Starts trace recording. */
  startTrace?(operation: OperationContext): Promise<void>;
  /** Stops trace recording and returns an artifact-relative path. */
  stopTrace?(operation: OperationContext): Promise<string>;
}

export interface TargetSession {
  /** Grammar verbs the backend can honor, read from its declaration. */
  readonly verbs: ReadonlySet<GrammarVerb>;
  /** Captures one atomic agent observation; the harness redacts it downstream. */
  observe(operation: OperationContext, options?: BackendObserveOptions): Promise<Observation>;
  /** Resolves immediately; the runner owns query polling and strictness. */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly NodeRef[]>;
  /** Reads one node from the resolution that minted its ref. */
  read(ref: NodeRef, operation: OperationContext): Promise<SemanticNode>;
  /** Performs exactly one action on a located or observed node. */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void>;
  /** Performs a viewport-level swipe. */
  swipe(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    operation: OperationContext,
  ): Promise<void>;
  readonly app: SessionApp;
  readonly artifacts: SessionArtifacts;
  /** Captures immutable app state for a session envelope. */
  captureState?(operation: OperationContext): Promise<BackendState>;
  /** Replaces current app state with an immutable captured state. */
  restoreState?(state: BackendState, operation: OperationContext): Promise<void>;
  /** Current top-level URL of the surface, when the platform has one. */
  url?(operation: OperationContext): Promise<string>;
  /** Ends the attempt's isolation within the operation's budget. Idempotent. */
  close(operation: OperationContext): Promise<void>;
}
