/**
 * The wire types of the in-page semantic reader. The reader itself lives in
 * `in-page/read-semantics.ts` and is serialized into the page.
 */

/**
 * The one definition of a secure field.
 *
 * It is a selector rather than a predicate because it has to be applied from
 * two sides that cannot share code: the in-page reader matches elements
 * against it to mark nodes `secure`, and the engine hands the same string to
 * the screenshot masker. One string means the tree's redaction and the image's
 * redaction cannot describe different sets of elements, which is what the
 * runner's pixel-clearance check relies on.
 */
export const SECURE_FIELD_SELECTOR = 'input[type="password" i]';

export interface RawNodeData {
  role: string | null;
  name: string | null;
  /**
   * Every label a person or a tool may call this control by: its `aria-label`,
   * each `aria-labelledby` target, and each associated `<label>`, read as an
   * accessible name (aria-hidden dropped). Null for a node with none. An exact
   * label query matches any one of them, as Playwright's `getByLabel` does,
   * rather than the combined or overridden `name`.
   */
  labels: string[] | null;
  text: string | null;
  value: string | null;
  /** Text selected inside the focused field or editing host; null when unfocused, collapsed, or secure. */
  selection: string | null;
  inputPurpose: 'username' | 'password' | 'one-time-code' | 'generic-secret' | 'none';
  states: {
    checked: boolean | null;
    disabled: boolean;
    selected: boolean | null;
    expanded: boolean | null;
    pressed: boolean | null;
    focused: boolean;
    hidden: boolean;
    secure: boolean;
  };
  /** Heading level of a heading: `aria-level`, else the digit of `h1` through `h6`; null for anything else. */
  level: number | null;
  attributes: Record<string, string>;
  /** Value of the project's test-id attribute, when the element carries one. */
  testId: string | null;
  /** The element's box in its document's viewport; null when it lays out no box (`display: none`). */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** The element's padding-box corner in the same viewport, when a border puts it past `rect`'s; null otherwise. */
  origin: { x: number; y: number } | null;
}

/** One observed node plus its position in the flattened depth-first tree. */
export interface RawObservedNode extends RawNodeData {
  /** Index of the nearest included ancestor, or -1 for the root. */
  parent: number;
  /** Unique CSS selector of this `<iframe>` element; set only for iframes. */
  frameSelector?: string;
}

/** One walked document. */
interface RawObservation {
  nodes: RawObservedNode[];
  /** True when the node budget stopped the walk before the document was read whole. */
  truncated: boolean;
  /** Live element handles positionally aligned with `nodes`. */
  elements: Element[];
  /**
   * Node ids positionally aligned with `nodes`. An id is stamped on the element
   * the first time an observation includes it and read back on every later
   * one, so the same element keeps the same id for as long as it lives in the
   * document: two looks at an unchanged screen name its nodes identically, and
   * an update can list exactly what changed. A re-created element (a framework
   * re-mount, a new document) is a new node and gets a fresh id.
   */
  ids: string[];
}

export type SemanticMode =
  | { kind: 'node' }
  /** The element's `states.hidden` alone, for the `visible` narrowing a selector engine applies. */
  | { kind: 'hidden' }
  /** Each listed element as `node` reads it, under one reader, so a batch pays for the reader's setup once. */
  | { kind: 'nodes'; elements: Element[] }
  /** The reads a locate matches elements by, in the locator projection (`LocatorReads`). */
  | { kind: 'locator' }
  | {
      kind: 'tree';
      maxNodes: number;
      /**
       * First numeric id available to nodes seen for the first time. The caller
       * reserves maxNodes ids before execution, so an abandoned reader cannot
       * collide with later captures or locator resolution.
       */
      idSeed: number;
      /** Cuts each node's name at this length; the caller owns the contract value. */
      nameLimit: number;
      /** Cuts each node's text at this length; the caller owns the contract value. */
      textLimit: number;
    };

/** Result of one read, selected by the mode discriminant. */
export type SemanticResult<Mode extends SemanticMode> = Mode extends { kind: 'node' }
  ? RawNodeData
  : Mode extends { kind: 'hidden' }
    ? boolean
    : Mode extends { kind: 'locator' }
      ? LocatorReads
      : Mode extends { kind: 'nodes' }
        ? RawNodeData[]
        : RawObservation;

/** An element's ARIA states as Playwright's role engine compares them: `mixed` and absent kept apart from false. */
export interface AriaStates {
  readonly checked: boolean | 'mixed';
  readonly pressed: boolean | 'mixed';
  readonly expanded: boolean | null;
  readonly selected: boolean;
}

/**
 * What a locate matches an element by, under one reader: each read is
 * computed when first asked and kept for the rest of the read, so a query
 * pays only for what it compares. Names follow the locator projection: a
 * list row, a status, or an alert takes no name from its content, and an
 * element the accessible name leaves unnamed is named by its first label.
 */
export interface LocatorReads {
  /** Whether the element's role is `role`; the empty-box role is computed only when asked for. */
  hasRole(element: Element, role: string): boolean;
  /** The name a role query compares. */
  name(element: Element): string | null;
  /** The label sources a label query compares; see `RawNodeData.labels`. */
  labels(element: Element): string[] | null;
  /** The element's text as Playwright's text engine joins it: its shadow roots included, whitespace collapsed. */
  text(element: Element): string;
  /** The element's `states.hidden`. */
  hidden(element: Element): boolean;
  /** Whether Playwright's role engine leaves the element out as hidden from the accessibility tree. */
  hiddenForAria(element: Element): boolean;
  /** The element's ARIA states, read for `role`. */
  states(element: Element, role: string): AriaStates;
  /** The element's `states.disabled`. */
  disabled(element: Element): boolean;
  /** The level a role query compares, as Playwright reads it: a heading tag's, else a whole `aria-level` of at least 1, else none. */
  level(element: Element): number | null;
  /** The value a display-value query compares: an input's (but a checkbox's or radio's), a textarea's, or a select's; null for a secure field and anything else. */
  displayValue(element: Element): string | null;
  /** The element as a node read, in the locator projection. */
  describe(element: Element): RawNodeData;
}
