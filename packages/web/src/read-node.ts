/**
 * The wire types of the in-page semantic reader and the page functions
 * assembled from its source for locator.evaluate, locator.evaluateAll, and
 * page.evaluate. The reader itself lives in `in-page/read-semantics.ts`; it is
 * serialized into the page, so every page function here is built from its
 * source with `new Function` and stays free of module-scope captures.
 */

import { readSemanticsFunction } from './in-page/read-semantics.ts';

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
  rect: { x: number; y: number; width: number; height: number };
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
  : RawObservation;

/** Options for a single-node read, shared by `evaluate` and `evaluateAll` callers. */
interface NodeReadOptions {
  readonly testIdAttribute: string;
  readonly secureFieldSelector: string;
  readonly mode: { readonly kind: 'node' };
}

/** Options for one document's tree walk. */
interface TreeReadOptions {
  readonly testIdAttribute: string;
  readonly secureFieldSelector: string;
  readonly mode: Extract<SemanticMode, { kind: 'tree' }>;
}

/**
 * Walks a whole document from its root element in one in-page call. Built
 * from the reader's source like the batch reader below, so the caller
 * evaluates it directly on a page or frame instead of first resolving a
 * `:root` locator - one fewer protocol round trip per document per capture.
 */
export const readDocumentSemanticsFunction = new Function(
  'options',
  `return (${readSemanticsFunction.toString()})(document.documentElement, options);`,
) as (options: TreeReadOptions) => RawObservation;

/**
 * Reads every matched element in one in-page round trip. A page function
 * cannot close over module scope, so the batch function is assembled from the
 * reader's own source (the same source `evaluate` sends) and is a
 * self-contained function Playwright serializes and calls with the elements.
 */
export const readManySemanticsFunction = new Function(
  'elements',
  'options',
  `return elements.map((element) => (${readSemanticsFunction.toString()})(element, options));`,
) as (elements: Element[], options: NodeReadOptions) => RawNodeData[];

/**
 * Reads every handle the caller already holds in one round trip, so what is
 * read and what is later acted on are the same elements by construction rather
 * than by a second lookup. Evaluated on the first handle so the read runs in
 * the frame the handles belong to; `page.evaluate` would reject handles taken
 * inside an iframe.
 */
export const readHandlesSemanticsFunction = new Function(
  '_first',
  'arg',
  `return arg.elements.map((element) => (${readSemanticsFunction.toString()})(element, arg.options));`,
) as (first: Element, arg: { elements: Element[]; options: NodeReadOptions }) => RawNodeData[];