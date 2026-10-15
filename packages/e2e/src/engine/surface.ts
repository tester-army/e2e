/**
 * The internal session surface the harness consumes for one attempt. It is
 * produced only by `createEngineSession` (the engine-to-session adapter) and
 * is never part of the public API: the locator engine, the agent tiers, and
 * the attempt executor program against it so that revision minting, staleness
 * checks, and capability gating exist exactly once.
 *
 * Re-exports the contract vocabulary so internal modules import one path.
 */

import type {
  LocatorAction,
  LocatorActionKind,
  LocatorExpression,
  Momentum,
  NodeRef,
  ObservationPixels,
  OperationContext,
  PointerAction,
  PointerActionKind,
  ScrollDirection,
  SemanticNode,
  ViewportPoint,
  ViewportSize,
} from './contract.ts';
import type { AppLogEntry, EngineObserveOptions, EngineSnapshot, EngineState, VideoSegment } from './index.ts';

export type * from './contract.ts';
export { EngineError } from './contract.ts';
export type { EngineObserveOptions, EngineState, VideoSegment } from './index.ts';

/**
 * The agent's action grammar, by verb. A session derives which verbs its
 * engine can honor from the action kinds the engine declared, so the agent
 * offers the model exactly that vocabulary. The vision-located tap and hover
 * are not verbs of their own: each rides its node verb when the located
 * point sits on a node the tree lists, and `performAt` when it does not.
 */
export type GrammarVerb =
  | 'tap'
  | 'doubleTap'
  | 'longPress'
  | 'secondaryTap'
  | 'hover'
  | 'type'
  | 'typeSecret'
  | 'press'
  | 'select'
  /** Sets a checkbox, switch, or radio to a state instead of flipping it; needs `check` and `uncheck`. */
  | 'check'
  | 'scroll'
  /** Brings one listed node into the viewport (`scrollIntoView`). */
  | 'scrollTo'
  /** Pages a list until a node reading a text is in view (`swipe`), for a row the tree has not listed yet. */
  | 'scrollUntil'
  | 'drag'
  | 'upload'
  | 'navigate'
  | 'back'
  | 'tapAt'
  | 'hoverAt'
  /** Keyboard input to whatever holds focus: `type` and `press` without a target. */
  | 'typeText'
  | 'pressKey'
  | 'dismissKeyboard';

export type Observation = ObservationMetadata & (
  | {
      readonly kind: 'semantic';
      readonly tree: SemanticNode;
      readonly truncated: boolean;
      /** The engine's measured keyboard state (`EngineSnapshot.keyboardVisible`); `false` when it measured none, absent only when it did not measure. */
      readonly keyboardVisible?: boolean;
      readonly pixels?: ObservationPixels;
    }
  | {
      readonly kind: 'pixels';
      readonly pixels: ObservationPixels;
    }
);

/** Capture identity and geometry, independent of whether semantic evidence exists. */
interface ObservationMetadata {
  /** Stable viewport action reference; it is not evidence that semantic nodes were captured. */
  readonly root: NodeRef;
  /** Where the surface was when captured, when the platform has a location. */
  readonly location?: string;
  readonly revision: string;
  readonly capturedAt: string;
  readonly viewport: ViewportSize;
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
  /** Starts video recording. */
  startVideo?(operation: OperationContext): Promise<void>;
  /** Stops video recording and returns the segments written, in order. */
  stopVideo?(operation: OperationContext): Promise<readonly VideoSegment[]>;
}

/**
 * Where the engine's app log goes. The engine reports from `startAttempt`
 * on, before any step records; what arrives before a sink is set waits, up
 * to a bound, and a serial group's members each point it at their own steps.
 */
export interface AppLogRoute {
  /** Takes one entry from the engine, checked: a malformed one is dropped. */
  push(entry: AppLogEntry): void;
  /** Takes one line saying where the app went (`EngineAttemptContext.navigation`); a blank one is dropped. */
  navigated(line: string): void;
  /** Sends everything from now on, and everything still waiting, to `sink`; undefined holds it again. */
  route(sink: ((event: AppEvent, at: string) => void) | undefined): void;
}

/** What the app did on its own, as the session passes it on: a log line, or where it went. */
export type AppEvent = { readonly kind: 'log'; readonly entry: AppLogEntry } | { readonly kind: 'navigation'; readonly line: string };

/**
 * Where the screens of an attempt go for its trace: what the engine handed
 * over (`EngineAttemptContext.screen`) and every observation the session
 * took. Without a sink they are dropped; nothing waits for them.
 */
export interface ScreenRoute {
  /** Whether the attempt keeps a trace; without one, nothing is pushed or routed, and the engine is not asked. */
  readonly traced: boolean;
  /** Takes one engine snapshot, checked: a malformed one is dropped. */
  push(snapshot: EngineSnapshot): void;
  /** Sends every screen from now on to `sink`; undefined drops them again. */
  route(sink: ((observation: Observation) => void) | undefined): void;
}

/** What the engine said the attempt runs on (`EngineAttemptContext.environment`), bounded. */
export interface EnvironmentFacts {
  /** Merges facts in, checked: a non-string value is dropped. */
  push(facts: Readonly<Record<string, string>>): void;
  /** The facts so far, each name and value redacted with `redact`, then clipped; undefined when there are none. */
  read(redact: (text: string) => string): Readonly<Record<string, string>> | undefined;
}

export interface TargetSession {
  /** Grammar verbs the engine can honor, derived from its declared action kinds and hooks. */
  readonly verbs: ReadonlySet<GrammarVerb>;
  /** Action kinds the engine declared for `perform`; empty without the actions capability. */
  readonly actions: ReadonlySet<LocatorActionKind>;
  /** Pointer action kinds the engine declared for `performAt`; empty without the pointer capability. */
  readonly pointerActions: ReadonlySet<PointerActionKind>;
  /** Whether the engine declared `tapModifiers`, so the tap actions may carry `modifiers`. */
  readonly tapModifiers: boolean;
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
  /** Performs one pointer action at a viewport point, in CSS pixels, with no node behind it. */
  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void>;
  /** Input to whatever holds focus; each member fails with UNSUPPORTED_CAPABILITY when the engine lacks it. */
  readonly keyboard: {
    type(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void>;
    press(key: string, operation: OperationContext): Promise<void>;
    dismiss(operation: OperationContext): Promise<void>;
  };
  readonly app: SessionApp;
  readonly artifacts: SessionArtifacts;
  readonly appLog: AppLogRoute;
  readonly screens: ScreenRoute;
  readonly environment: EnvironmentFacts;
  /** Captures immutable app state for a session envelope. */
  captureState?(operation: OperationContext): Promise<EngineState>;
  /** Replaces current app state with an immutable captured state. */
  restoreState?(state: EngineState, operation: OperationContext): Promise<void>;
  /** Rethrows a failure the engine collected on a path no step awaited; a no-op without the hook. */
  settle(operation: OperationContext): Promise<void>;
  /** Ends the attempt's isolation within the operation's budget. Idempotent. */
  close(operation: OperationContext): Promise<void>;
}
