/**
 * The engine contract vocabulary: the platform-neutral types every
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
  /**
   * Who asked: a test's own deterministic step, or the agent acting on a
   * screen it observed. A deterministic step verifies its outcome with
   * `expect`, so an engine may act as soon as the target holds still; an
   * agent reads the screen right after acting, so an engine may wait for the
   * transition to end first.
   */
  readonly origin: 'test' | 'agent';
}

export type TextPattern =
  | { readonly kind: 'string'; readonly value: string; readonly exact: boolean }
  | { readonly kind: 'regexp'; readonly source: string; readonly flags: string };

export type QueryKind = 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId';

export interface SemanticQuery {
  readonly kind: QueryKind;
  readonly value: TextPattern;
  readonly name?: TextPattern;
  /**
   * States a role query requires. A role query never matches a node whose
   * `states.hidden` is true, as a browser's role selector never does; there is
   * no state that widens it to hidden nodes.
   */
  readonly states?: Readonly<
    Partial<Record<'checked' | 'disabled' | 'selected' | 'expanded', boolean>>
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
  /**
   * The node's test id, when the platform gives it one: the value of the
   * project's test-id attribute on a document platform, an accessibility
   * identifier on iOS, a resource id on Android, an automation id on a
   * desktop. The `testId` query resolves against exactly this field, so the
   * harness never knows where a platform keeps it.
   */
  readonly testId?: string;
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
  /**
   * The node's box in the top-level viewport's CSS pixels (`ViewportPoint`
   * space), for every node, including those inside nested documents: an
   * engine that measures a child document against its own viewport shifts
   * the boxes by the boundary element's before reporting them.
   */
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
   * so it does not survive to the later run it exists for.
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
 * Viewport point in CSS pixels, origin at the top-left of the viewport: the
 * space `SemanticNode.rect` is in, and the space `Engine.tapAt` dispatches in.
 * A point read off `ObservationPixels` is divided by its `scale` to get here.
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

/**
 * One deterministic action `perform` carries out on a node. The `swipe`
 * kind on the observation's root node is the viewport swipe: the agent's
 * `scroll` verb and `screen.swipe()` both arrive as `perform(root, swipe)`,
 * so a surface implements scrolling once.
 *
 * `press` takes one key in the `Key` grammar below.
 */
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
  | { readonly kind: 'press'; readonly key: Key }
  | { readonly kind: 'selectOption'; readonly value: SelectOption }
  | { readonly kind: 'setInputFiles'; readonly paths: readonly string[] }
  | { readonly kind: 'dragTo'; readonly target: NodeRef }
  | {
      readonly kind: 'swipe';
      readonly direction: ScrollDirection;
      readonly momentum?: Momentum;
    };

/** Every action kind; what an engine declares in `actions`. */
export type LocatorActionKind = LocatorAction['kind'];

/** The closed list of action kinds, in contract order; the type is derived from it. */
export const LOCATOR_ACTION_KINDS = [
  'tap',
  'doubleTap',
  'longPress',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'focus',
  'hover',
  'scrollIntoView',
  'selectOption',
  'setInputFiles',
  'dragTo',
  'swipe',
] as const satisfies readonly LocatorActionKind[];

/**
 * The key grammar of `press`, shared by every engine so a test's key names are
 * portable: zero or more modifiers and one key, joined by `+`.
 *
 * - Modifiers: `Shift`, `Control`, `Alt`, `Meta`, `ControlOrMeta` (Control on
 *   Windows and Linux, Meta on macOS).
 * - Named keys: those in `KEY_NAMES` (`Enter`, `Escape`, `Tab`, `Backspace`,
 *   `Delete`, `ArrowUp`..., `Home`, `End`, `PageUp`, `PageDown`, `Insert`,
 *   `Space`, `F1`..`F12`).
 * - Any single printable character (`a`, `A`, `1`, `$`), typed as itself.
 *
 * `Control+a`, `Shift+Tab`, `Enter`, `$`. A platform without a key maps it
 * or throws `UNSUPPORTED_CAPABILITY`; it never reinterprets the spelling.
 * `parseKey` is the one parser, exported so no engine carries its own.
 */
export type Key = string;

export const KEY_MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta'] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export const KEY_NAMES = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** One parsed `press` key: its modifiers and either a named key or a single character. */
export interface ParsedKey {
  readonly modifiers: readonly KeyModifier[];
  readonly key: { readonly kind: 'named'; readonly name: KeyName } | { readonly kind: 'char'; readonly char: string };
}

const MODIFIER_SET: ReadonlySet<string> = new Set(KEY_MODIFIERS);
/** Control, format, surrogate, private-use, unassigned, and line or paragraph separators: never a printable key. */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const NAME_SET: ReadonlySet<string> = new Set(KEY_NAMES);

/**
 * Parses a `press` key against the grammar; `undefined` when it does not
 * conform (an unknown name, a repeated modifier, a bare modifier, or several
 * characters). A literal `+` is the character after the last separator, so
 * `Shift++` presses `+` with Shift held.
 */
export function parseKey(key: string): ParsedKey | undefined {
  if (key === '') return undefined;
  if (key === '+') return { modifiers: [], key: { kind: 'char', char: '+' } };
  // A trailing `+` is the key itself, so the separator before it (the last
  // two characters, `<sep>+`) is cut and `+` appended as the final part.
  const parts = key.endsWith('+') && key.length > 1 ? [...key.slice(0, -2).split('+'), '+'] : key.split('+');
  const last = parts.pop();
  if (last === undefined || last === '') return undefined;
  const modifiers: KeyModifier[] = [];
  for (const part of parts) {
    if (!MODIFIER_SET.has(part) || modifiers.includes(part as KeyModifier)) return undefined;
    modifiers.push(part as KeyModifier);
  }
  if (NAME_SET.has(last)) return { modifiers, key: { kind: 'named', name: last as KeyName } };
  if ([...last].length === 1 && !NON_PRINTABLE.test(last)) return { modifiers, key: { kind: 'char', char: last } };
  return undefined;
}

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
