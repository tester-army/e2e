/**
 * The engine contract vocabulary (RFC0002): the platform-neutral types every
 * engine speaks and the harness consumes. An engine imports these from
 * `@e2edev/e2e/engine`; core never imports anything from an engine.
 *
 * Everything here is capability vocabulary - semantic nodes, locator
 * expressions, action kinds, the error contract - never a platform noun. A
 * document platform, a simulator, and a desktop shell describe themselves with the same
 * words, which is what lets `screen`, `expect`, and the agent work identically
 * on all of them.
 */

import type { Momentum, ScrollDirection, SelectOption } from '../types.ts';

/** The engine contract version this runner speaks. */
export const ENGINE_SPI_VERSION = 1;
export type EngineSpiVersion = typeof ENGINE_SPI_VERSION;

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
  /**
   * When true, an engine MUST exclude every match whose `states.hidden` would
   * be true, using the same predicate its `SemanticNode` reports, so that the
   * query set the harness counts is the set `toBeVisible()` would accept. The
   * predicate applies wherever the query sits in an expression: under a
   * scope, inside a filter, or before an index.
   */
  readonly visible?: boolean;
}

/**
 * The location capability's query language. `selector` is a platform-native
 * selector string (CSS or XPath on a document platform, a predicate on a
 * device platform); `frame` scopes a query inside one nested document.
 */
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
      readonly kind: 'selector';
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
 * Per-field bounds an engine applies to observation-tree nodes. A `name` or
 * `text` whose length reaches its limit was cut at exactly that limit, so
 * "length >= limit" is a precise truncation signal; every shorter value is
 * complete. Single-node reads are unbounded and always carry the full value.
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
   * Platform selector that addresses this node within its own document, when
   * the platform has one. It is structural, not semantic: it survives the
   * content changes that rename a node, and a runner may store it to re-find
   * the node cheaply on a later run. It is never part of the node's identity,
   * so whatever it resolves to is still checked before it is used.
   *
   * It SHOULD be anchored on an attribute naming the node or one of its
   * ancestors, and SHOULD be absent rather than positional all the way to the
   * document root: such a path is shifted by anything inserted above the node,
   * so it does not survive to the later run it exists for (10-determinism.md).
   */
  readonly selector?: string;
  /**
   * Enclosing nested-document chain as selectors of each boundary node,
   * outermost first. Absent for nodes in the main document.
   */
  readonly framePath?: readonly string[];
  readonly children?: readonly SemanticNode[];
}

/**
 * Viewport point in CSS pixels, origin at the top-left of the viewport.
 * Reserved for coordinate-addressed actions; no runner surface consumes it yet.
 */
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

/** One deterministic action the location tier performs on a located node. */
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

/** The closed engine error code set; the type is derived from it, so the two cannot drift. */
export const ENGINE_ERROR_CODES = [
  'NODE_STALE',
  'FRAME_NOT_FOUND',
  'FRAME_AMBIGUOUS',
  'NOT_ACTIONABLE',
  'ACTION_MAY_HAVE_COMMITTED',
  'OPERATION_TIMEOUT',
  'CANCELLED',
  'UNSUPPORTED_CAPABILITY',
  'INVALID_STATE',
  'ENGINE_FAILURE',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/**
 * The only codes that may be retryable: both describe a repeatable read. Any
 * other retryable claim, from this module's class or a foreign copy of it, is
 * coerced to a non-retryable `ENGINE_FAILURE`.
 */
export const RETRYABLE_ENGINE_ERROR_CODES: ReadonlySet<EngineErrorCode> = new Set([
  'NODE_STALE',
  'FRAME_NOT_FOUND',
]);

/**
 * The error contract an engine throws across the seam. Retryability is closed
 * to `RETRYABLE_ENGINE_ERROR_CODES`; any other retryable claim is coerced to
 * a non-retryable `ENGINE_FAILURE` so an engine can never talk the harness
 * into repeating an action that may have committed.
 */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(
    code: EngineErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineError';
    if (options.retryable && !RETRYABLE_ENGINE_ERROR_CODES.has(code)) {
      this.code = 'ENGINE_FAILURE';
      this.retryable = false;
      return;
    }
    this.code = code;
    this.retryable = options.retryable;
  }
}
