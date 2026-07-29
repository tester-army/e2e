/**
 * Public driver-1 SPI. Mirrors spec/api/driver.d.ts; the spec file wins on any
 * divergence.
 */

import { driverHandleBrand } from '../internal/brands.ts';
import type {
  Capability,
  Cookie,
  DriverHandle,
  DriverManifest,
  JsonValue,
  Momentum,
  RouteFulfillResponse,
  SelectOption,
  ScrollDirection,
  Target,
} from '../types.ts';

export interface OperationContext {
  readonly signal: AbortSignal;
  /** Remaining operation budget when the call starts. */
  readonly timeoutMs: number;
  readonly runId: string;
  readonly attemptId: string;
}

export type TextPattern =
  | { readonly kind: 'string'; readonly value: string; readonly exact: boolean }
  | { readonly kind: 'regexp'; readonly source: string; readonly flags: string };

export type QueryKind = 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId';

export interface SemanticQuery {
  readonly kind: QueryKind;
  readonly value: TextPattern;
  readonly name?: TextPattern;
  readonly states?: Readonly<
    Partial<Record<'checked' | 'disabled' | 'selected' | 'expanded' | 'hidden', boolean>>
  >;
}

export type LocatorExpression =
  | {
      readonly kind: 'query';
      readonly query: SemanticQuery;
      readonly scope?: LocatorExpression;
    }
  | {
      readonly kind: 'filter';
      readonly source: LocatorExpression;
      readonly hasText?: TextPattern;
      readonly has?: LocatorExpression;
    }
  | {
      readonly kind: 'index';
      readonly source: LocatorExpression;
      readonly index: number | 'first' | 'last';
    }
  | {
      readonly kind: 'web-selector';
      readonly selector: string;
    }
  | {
      readonly kind: 'frame';
      readonly selector: string;
      readonly source: LocatorExpression;
    };

export interface NodeRef {
  readonly id: string;
  readonly revision: string;
}

/**
 * Per-field bounds a driver applies to observation-tree nodes. A `name` or
 * `text` whose length reaches its limit was cut at exactly that limit, so
 * "length >= limit" is a precise truncation signal; every shorter value is
 * complete. Single-node reads (`screen.read`) are unbounded and always carry
 * the full value.
 */
export const OBSERVED_NAME_LIMIT = 256;
export const OBSERVED_TEXT_LIMIT = 512;

export interface SemanticNode {
  readonly ref: NodeRef;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly inputPurpose?: 'username' | 'password' | 'one-time-code' | 'generic-secret' | 'none';
  readonly states?: Readonly<
    Partial<
      Record<
        'checked' | 'disabled' | 'selected' | 'expanded' | 'focused' | 'hidden' | 'secure',
        boolean
      >
    >
  >;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /**
   * Enclosing frame chain as CSS selectors of each `<iframe>` element,
   * outermost first. Absent for nodes in the main document.
   */
  readonly framePath?: readonly string[];
  readonly children?: readonly SemanticNode[];
}

/** Viewport point in CSS pixels, origin at the top-left of the viewport. */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Masked viewport pixels captured for one observation revision.
 *
 * `width` and `height` MUST be the true dimensions of `data`, because they are
 * the space every coordinate read off the image refers to. `scale` relates that
 * space to the CSS pixels of `SemanticNode.rect`, which is the space actions
 * dispatch in: one image pixel is `1 / scale` CSS pixels.
 */
export interface ObservationPixels {
  readonly data: Uint8Array;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  /** Image pixels per CSS pixel; 1 for a CSS-scale capture. */
  readonly scale: number;
}

export interface ObserveOptions {
  /**
   * Requests masked viewport pixels for the same revision as the tree. A
   * driver that cannot produce them omits `Observation.pixels` instead of
   * failing the observation.
   */
  readonly pixels?: boolean;
}

export interface Observation {
  readonly revision: string;
  readonly capturedAt: string;
  readonly screenshot?: string;
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

export type LocatorAction =
  | {
      readonly kind:
        | 'tap'
        | 'doubleTap'
        | 'check'
        | 'uncheck'
        | 'clear'
        | 'focus'
        | 'hover'
        | 'scrollIntoView';
    }
  | { readonly kind: 'longPress'; readonly durationMs?: number }
  | { readonly kind: 'fill'; readonly value: string; readonly sensitive: boolean }
  | { readonly kind: 'press'; readonly key: string }
  | { readonly kind: 'selectOption'; readonly value: SelectOption }
  | { readonly kind: 'setInputFiles'; readonly paths: readonly string[] }
  | { readonly kind: 'dragTo'; readonly target: NodeRef }
  | {
      readonly kind: 'swipe';
      readonly direction: ScrollDirection;
      readonly momentum?: Momentum;
    };

export type DriverErrorCode =
  | 'NODE_STALE'
  | 'FRAME_NOT_FOUND'
  | 'FRAME_AMBIGUOUS'
  | 'NOT_ACTIONABLE'
  | 'ACTION_MAY_HAVE_COMMITTED'
  | 'OPERATION_TIMEOUT'
  | 'CANCELLED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_STATE'
  | 'DRIVER_FAILURE';

const LEGAL_RETRYABLE: ReadonlySet<DriverErrorCode> = new Set(['NODE_STALE', 'FRAME_NOT_FOUND']);

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly retryable: boolean;

  constructor(
    code: DriverErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DriverError';
    if (options.retryable && !LEGAL_RETRYABLE.has(code)) {
      this.code = 'DRIVER_FAILURE';
      this.retryable = false;
      return;
    }
    this.code = code;
    this.retryable = options.retryable;
  }
}

export interface DriverState {
  readonly format: string;
  readonly version: number;
  readonly data: JsonValue;
  readonly expiresAt?: string;
}

export interface DriverCapabilities {
  readonly fixtures: readonly Capability[];
  readonly artifacts: readonly ('screenshot' | 'trace' | 'video')[];
  readonly state: boolean;
}

export interface DriverContext {
  readonly target: Target;
  readonly targetId: string;
  readonly app: {
    readonly baseUrl: string;
    readonly allowedOrigins: readonly string[];
    readonly environment: 'test' | 'staging' | 'production';
    readonly allowProduction: boolean;
    readonly testIdAttribute: string;
  };
  readonly artifactsDir: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly operation: OperationContext;
  readonly launchOptions: {
    readonly headed: boolean;
  };
}

export interface CleanupContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly runId: string;
  readonly attemptId: string;
}

export interface DriverApp {
  /** Opens the app. */
  open(path: string | undefined, operation: OperationContext): Promise<void>;
  /** Recreates the app context without clearing persisted state. */
  restart(operation: OperationContext): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState(operation: OperationContext): Promise<void>;
  /** Navigates back once. */
  back(operation: OperationContext): Promise<void>;
  /** Opens an allowed deep link. */
  deepLink(url: string, operation: OperationContext): Promise<void>;
}

export interface DriverScreen {
  /** Resolves immediately; the runner owns query polling and strictness. */
  resolve(expression: LocatorExpression, operation: OperationContext): Promise<readonly NodeRef[]>;
  /** Reads one node from its observation revision. */
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

export interface DriverAgentActions {
  /** Taps one semantic node. */
  tap(target: { readonly ref: NodeRef }, operation: OperationContext): Promise<void>;
  /** Long-presses one semantic node. */
  longPress(
    target: { readonly ref: NodeRef },
    durationMs: number | undefined,
    operation: OperationContext,
  ): Promise<void>;
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
  /** Sends one key. */
  press(key: string, operation: OperationContext): Promise<void>;
  /**
   * Taps one runner-validated viewport point. Optional: a driver without
   * coordinate input omits it, and vision pointing that hit-tests to no
   * semantic node then fails instead of dispatching.
   */
  tapPoint?(point: ViewportPoint, operation: OperationContext): Promise<void>;
}

export interface DriverWebRoute {
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
  /** Fulfills the route once. */
  fulfill(response: RouteFulfillResponse, operation: OperationContext): Promise<void>;
  /** Continues the route once. */
  continue(operation: OperationContext): Promise<void>;
  /** Aborts the route once. */
  abort(operation: OperationContext): Promise<void>;
}

export interface DriverWebResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface DriverDialog {
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text: string | undefined, operation: OperationContext): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(operation: OperationContext): Promise<void>;
}

export interface DriverWeb {
  /** Navigates to one URL. */
  goto(
    url: string,
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | undefined,
    operation: OperationContext,
  ): Promise<void>;
  /** Reloads the document. */
  reload(operation: OperationContext): Promise<void>;
  /** Navigates back. */
  back(operation: OperationContext): Promise<void>;
  /** Navigates forward. */
  forward(operation: OperationContext): Promise<void>;
  /** Returns the current URL. */
  url(operation: OperationContext): Promise<string>;
  /** Returns the current title. */
  title(operation: OperationContext): Promise<string>;
  /** Evaluates trusted test code in the page. */
  evaluate<T extends JsonValue>(
    source: string,
    argument: JsonValue | undefined,
    operation: OperationContext,
  ): Promise<T>;
  /** Adds an attempt-scoped route. */
  route(
    pattern: TextPattern,
    handler: (route: DriverWebRoute) => void | Promise<void>,
    operation: OperationContext,
  ): Promise<void>;
  /** Removes matching routes. */
  unroute(pattern: TextPattern, operation: OperationContext): Promise<void>;
  /** Waits for one response. */
  waitForResponse(pattern: TextPattern, operation: OperationContext): Promise<DriverWebResponse>;
  /** Returns current cookies. */
  cookies(operation: OperationContext): Promise<readonly Cookie[]>;
  /** Sets current cookies. */
  setCookies(cookies: readonly Cookie[], operation: OperationContext): Promise<void>;
  /** Sets the viewport. */
  setViewport(
    size: { readonly width: number; readonly height: number },
    operation: OperationContext,
  ): Promise<void>;
  /** Registers an attempt-scoped dialog policy. */
  setDialogHandler(
    handler: 'accept' | 'dismiss' | ((dialog: DriverDialog) => void | Promise<void>),
    operation: OperationContext,
  ): Promise<string>;
  /** Removes one dialog policy. */
  removeDialogHandler(id: string, operation: OperationContext): Promise<void>;
  /** Creates an attempt-scoped download waiter before the runner invokes its trigger. */
  beginDownload(operation: OperationContext): Promise<string>;
  /** Waits for a previously created download waiter. */
  finishDownload(
    id: string,
    operation: OperationContext,
  ): Promise<{ readonly path: string; readonly suggestedFilename: string }>;
  /** Cancels and removes a download waiter. */
  cancelDownload(id: string, operation: OperationContext): Promise<void>;
  /** Sends one keyboard key. */
  keyboardPress(key: string, operation: OperationContext): Promise<void>;
  /** Types plain keyboard text. */
  keyboardType(text: string, operation: OperationContext): Promise<void>;
  /** Moves the pointer. */
  mouseMove(x: number, y: number, operation: OperationContext): Promise<void>;
  /** Scrolls the pointer wheel. */
  mouseWheel(deltaX: number, deltaY: number, operation: OperationContext): Promise<void>;
  /** Presses the pointer button. */
  mouseDown(operation: OperationContext): Promise<void>;
  /** Releases the pointer button. */
  mouseUp(operation: OperationContext): Promise<void>;
}

export interface DriverArtifacts {
  /** Captures a redacted screenshot and returns an artifact-relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string>;
  /** Starts trace recording. */
  startTrace?(operation: OperationContext): Promise<void>;
  /** Stops trace recording and returns an artifact-relative path. */
  stopTrace?(operation: OperationContext): Promise<string>;
  /** Starts video recording. */
  startVideo?(operation: OperationContext): Promise<void>;
  /** Stops video recording and returns an artifact-relative path. */
  stopVideo?(operation: OperationContext): Promise<string>;
}

export interface DriverRuntime {
  readonly browser?: {
    readonly name: 'chromium' | 'firefox' | 'webkit';
    readonly version: string;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
}

export interface DriverSession {
  readonly app: DriverApp;
  readonly screen: DriverScreen;
  readonly actions: DriverAgentActions;
  readonly web?: DriverWeb;
  readonly artifacts: DriverArtifacts;
  readonly capabilityFixtures?: Readonly<Record<string, unknown>>;
  /** Captures immutable app state for a session envelope. */
  captureState?(operation: OperationContext): Promise<DriverState>;
  /** Replaces current app state with an immutable captured state. */
  restoreState?(state: DriverState, operation: OperationContext): Promise<void>;
  /** Captures one atomic, fully redacted agent observation. */
  observe(operation: OperationContext, options?: ObserveOptions): Promise<Observation>;
  /** Returns current runtime provenance after viewport/backend changes. */
  runtime(operation: OperationContext): Promise<DriverRuntime>;
  /** Releases all session resources. It MUST be idempotent. */
  close(context: CleanupContext): Promise<void>;
}

export interface Driver extends DriverHandle {
  /**
   * Launches one logical test or serial-group attempt. Sessions of one
   * driver instance are strictly serialized: the runner never calls launch
   * while a previous session of this instance is still open. Parallel
   * execution uses one driver instance per worker, never concurrent
   * sessions on a shared instance.
   */
  launch(context: DriverContext): Promise<DriverSession>;
  /**
   * Releases backend resources retained between sessions (for example a
   * pooled browser process, booted simulator, or device lease). The runner
   * calls it at most once per driver instance, after every session is
   * closed. It MUST be idempotent and MUST NOT affect previously captured
   * artifacts or state.
   */
  dispose?(): Promise<void>;
}

export interface DriverDefinition extends DriverManifest {
  /** Launches one logical test or serial-group attempt. */
  launch(context: DriverContext): Promise<DriverSession>;
  /** Releases resources retained between sessions. It MUST be idempotent. */
  dispose?(): Promise<void>;
}

const DRIVER_ID_PATTERN = /^[a-z0-9\-./]+$/;

/** Type-checks, validates, and brands a driver-1 implementation. */
export function defineDriver(driver: DriverDefinition): Driver {
  if (driver.spiVersion !== 1) {
    throw new TypeError(`unsupported driver SPI version: ${String(driver.spiVersion)}`);
  }
  if (typeof driver.id !== 'string' || !DRIVER_ID_PATTERN.test(driver.id)) {
    throw new TypeError(
      'driver id must contain lowercase ASCII letters, numbers, "-", ".", or "/"',
    );
  }
  if (typeof driver.version !== 'string' || driver.version.length === 0) {
    throw new TypeError('driver version is required');
  }
  if (!Array.isArray(driver.platforms) || driver.platforms.length === 0) {
    throw new TypeError('driver platforms must be a nonempty array');
  }
  if (typeof driver.launch !== 'function') {
    throw new TypeError('driver launch must be a function');
  }
  if (driver.dispose !== undefined && typeof driver.dispose !== 'function') {
    throw new TypeError('driver dispose must be a function when present');
  }
  return Object.freeze({
    ...driver,
    [driverHandleBrand]: true as const,
  });
}

export type DriverProfile = 'driver-1' | 'core-0.1' | 'web-0.1';

export interface DriverConformanceResult {
  readonly requirementId: string;
  readonly status: 'passed' | 'failed';
  readonly message?: string;
  readonly evidence: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface DriverConformanceReport {
  readonly schemaVersion: 'conformance-1';
  readonly profile: DriverProfile;
  readonly suiteVersion: string;
  readonly manifestSha256: string;
  readonly implementation: {
    readonly name: string;
    readonly version: string;
    readonly artifactSha256: string;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: 'passed' | 'failed';
  readonly results: readonly DriverConformanceResult[];
}

/**
 * Runs the reference application and machine-executable driver vectors.
 * The conformance harness ships with a later Phase 1 milestone.
 */
export function verifyDriver(options: {
  driver: Driver;
  profiles: readonly DriverProfile[];
  artifactSha256: string;
  createTarget(referenceAppUrl: string): Target | Promise<Target>;
}): Promise<readonly DriverConformanceReport[]> {
  void options;
  return Promise.reject(
    new Error(
      'verifyDriver is not implemented yet: the driver conformance harness lands with a later Phase 1 milestone',
    ),
  );
}

/** Returns true when the value is a defineDriver-branded handle. */
export function isDriverHandle(value: unknown): value is Driver {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[driverHandleBrand] === true
  );
}

export type {
  Capability,
  Cookie,
  DriverHandle,
  DriverManifest,
  JsonValue,
  Momentum,
  Platform,
  RouteFulfillResponse,
  SelectOption,
  ScrollDirection,
  Target,
} from '../types.ts';
