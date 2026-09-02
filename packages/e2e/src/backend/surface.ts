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
  ViewportPoint,
} from './contract.ts';
import type { BackendState } from './index.ts';

export type * from './contract.ts';
export { BackendError, OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from './contract.ts';
export type { BackendState } from './index.ts';

export interface ObserveOptions {
  /**
   * Requests masked viewport pixels for the same revision as the tree. A
   * backend that cannot produce them omits `Observation.pixels` instead of
   * failing the observation.
   */
  readonly pixels?: boolean;
}

export interface Observation {
  readonly revision: string;
  readonly capturedAt: string;
  readonly pixels?: ObservationPixels;
  readonly tree: SemanticNode;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
  readonly redaction: {
    readonly secureNodeCount: number;
    readonly maskedRegionCount: number;
    readonly complete: boolean;
  };
}

export interface SessionApp {
  /** Opens the app at one resolved URL. */
  open(url: string, operation: OperationContext): Promise<void>;
  /** Recreates the app context without clearing persisted state. */
  restart(operation: OperationContext): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState(operation: OperationContext): Promise<void>;
  /** Navigates back once. */
  back(operation: OperationContext): Promise<void>;
}

export interface SessionScreen {
  /** Resolves immediately; the runner owns query polling and strictness. */
  resolve(expression: LocatorExpression, operation: OperationContext): Promise<readonly NodeRef[]>;
  /** Reads one node from the resolution that minted its ref. */
  read(ref: NodeRef, operation: OperationContext): Promise<SemanticNode>;
  /** Performs exactly one action with backend actionability checks. */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void>;
  /** Performs a viewport-level swipe. */
  swipe(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    operation: OperationContext,
  ): Promise<void>;
}

export interface SessionActions {
  /** Taps one semantic node. */
  tap(target: { readonly ref: NodeRef }, operation: OperationContext): Promise<void>;
  /** Types one plain or sensitive host-resolved value. */
  type(
    target: { readonly ref: NodeRef },
    value: string,
    sensitive: boolean,
    operation: OperationContext,
  ): Promise<void>;
  /** Scrolls the viewport or one semantic node. */
  scroll(
    direction: ScrollDirection,
    options: { readonly target?: NodeRef; readonly momentum?: Momentum },
    operation: OperationContext,
  ): Promise<void>;
  /**
   * Taps one runner-validated viewport point. Optional: a backend without
   * coordinate input omits it, and vision pointing that hit-tests to no
   * semantic node then fails instead of dispatching.
   */
  tapPoint?(point: ViewportPoint, operation: OperationContext): Promise<void>;
}

export interface SessionArtifacts {
  /** Captures a redacted screenshot and returns an artifact-relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string>;
  /** Starts trace recording. */
  startTrace?(operation: OperationContext): Promise<void>;
  /** Stops trace recording and returns an artifact-relative path. */
  stopTrace?(operation: OperationContext): Promise<string>;
}

export interface SessionRuntime {
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
}

export interface TargetSession {
  readonly app: SessionApp;
  readonly screen: SessionScreen;
  readonly actions: SessionActions;
  readonly artifacts: SessionArtifacts;
  /** Captures immutable app state for a session envelope. */
  captureState?(operation: OperationContext): Promise<BackendState>;
  /** Replaces current app state with an immutable captured state. */
  restoreState?(state: BackendState, operation: OperationContext): Promise<void>;
  /** Captures one atomic, fully redacted agent observation. */
  observe(operation: OperationContext, options?: ObserveOptions): Promise<Observation>;
  /** Current top-level URL of the surface, when the platform has one. */
  url?(operation: OperationContext): Promise<string>;
  /** Returns current runtime provenance after viewport changes. */
  runtime(operation: OperationContext): Promise<SessionRuntime>;
  /** Ends the attempt's isolation. It MUST be idempotent. */
  close(operation: OperationContext): Promise<void>;
}
