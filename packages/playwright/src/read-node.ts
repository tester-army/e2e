/**
 * In-page semantic reader executed via locator.evaluate, locator.evaluateAll,
 * and locator.evaluateHandle. Everything below the exported functions is
 * serialized into the page, so it must stay self-contained: no imports, no
 * module-scope references, every constant inside the function body.
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
  text: string | null;
  value: string | null;
  inputPurpose: 'username' | 'password' | 'one-time-code' | 'generic-secret' | 'none';
  states: {
    checked: boolean | null;
    disabled: boolean;
    selected: boolean | null;
    expanded: boolean | null;
    focused: boolean;
    hidden: boolean;
    secure: boolean;
  };
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

/** One observed node plus its position in the flattened depth-first tree. */
export interface RawObservedNode extends RawNodeData {
  /** Index of the nearest included ancestor, or -1 for the root. */
  parent: number;
  /** Unique CSS selector of this `<iframe>` element; set only for iframes. */
  frameSelector?: string;
}

/**
 * One walked document. The contract has no way to report a truncated tree, so the
 * node budget is a safety valve, not a signal: when it stops the walk early
 * the result simply ends, and the runner's visible observation byte budget is
 * the effective limit.
 */
interface RawObservation {
  nodes: RawObservedNode[];
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
  /** The first id not yet handed out; the caller seeds the next document with it. */
  nextId: number;
}

type SemanticMode =
  | { kind: 'node' }
  | {
      kind: 'tree';
      maxNodes: number;
      /**
       * First numeric id available to nodes seen for the first time. The caller
       * owns the id space across documents and frames, so ids never collide
       * with those minted for another document or for locator resolution.
       */
      idSeed: number;
      /** Cuts each node's name at this length; the caller owns the contract value. */
      nameLimit: number;
      /** Cuts each node's text at this length; the caller owns the contract value. */
      textLimit: number;
    };

/** Result of one read, selected by the mode discriminant. */
type SemanticResult<Mode extends SemanticMode> = Mode extends { kind: 'node' }
  ? RawNodeData
  : RawObservation;

/**
 * Serialized into the page by Playwright. Must stay self-contained: no outer
 * captures beyond its two arguments.
 *
 * `mode.kind === 'node'` reads exactly one element for locator reads.
 * `mode.kind === 'tree'` walks the subtree for one agent observation and
 * returns live element handles aligned with the flattened node list. The two
 * modes also project nodes differently; those differences are data (see
 * `projection` below), not scattered branches.
 */
const readSemanticsFunction = <Mode extends SemanticMode>(
  element: Element,
  options: { testIdAttribute: string; secureFieldSelector: string; mode: Mode },
): SemanticResult<Mode> => {
  const SKIP_TAGS = [
    'script',
    'style',
    'noscript',
    'template',
    'head',
    'meta',
    'link',
    'title',
    'base',
    'param',
    'source',
    'track',
    'col',
    'colgroup',
    'frame',
    'frameset',
    'object',
    'embed',
  ];
  const OPAQUE_TAGS = ['svg', 'math', 'canvas', 'video', 'audio'];
  /** Options listed under one select; a country picker's tail is not worth the tokens. */
  const MAX_SELECT_OPTIONS = 60;

  /**
   * How the active mode projects one node, expressed as data so `describe`
   * stays branch-free. Tree mode is the model-bound projection: bounded text,
   * a bounded attribute projection, hrefs reduced to origin+path, and the root
   * document named by its title. Node mode is the full locator-read surface.
   */
  const projection: {
    attributes: readonly string[] | null;
    textLimit: number | null;
    nameLimit: number | null;
    redactHref: boolean;
    directTextOnly: boolean;
    documentRoot: boolean;
  } =
    options.mode.kind === 'tree'
      ? {
          attributes: [options.testIdAttribute, 'type', 'autocomplete', 'href', 'role'],
          textLimit: options.mode.textLimit,
          nameLimit: options.mode.nameLimit,
          redactHref: true,
          directTextOnly: true,
          documentRoot: true,
        }
      : {
          attributes: null,
          textLimit: null,
          nameLimit: null,
          redactHref: false,
          directTextOnly: false,
          documentRoot: false,
        };

  /**
   * Per-element memo for the facts several passes need. A tree walk asks for
   * an element's role, name, and direct text from `isInteresting`, `describe`,
   * and the empty-box test; each is a pure function of the element for the
   * duration of one read, and `innerText` in particular forces layout.
   */
  const memoized = <T,>(compute: (el: Element) => T): ((el: Element) => T) => {
    const cache = new Map<Element, T>();
    return (el) => {
      if (cache.has(el)) return cache.get(el) as T;
      const value = compute(el);
      cache.set(el, value);
      return value;
    };
  };

  const implicitRole = memoized((el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit !== null && explicit !== '') return explicit.split(/\s+/)[0] ?? null;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
        return 'button';
      case 'select':
        return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return el.getAttribute('alt') === '' ? 'presentation' : 'image';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'option':
        return 'option';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'li':
        return 'listitem';
      case 'ul':
      case 'ol':
        return 'list';
      case 'table':
        return 'table';
      // Rows and cells carry the structure a table's controls belong to: a
      // "Delete" button means one thing per row, and only the row says which.
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return 'columnheader';
      case 'dialog':
        return 'dialog';
      case 'output':
        return 'status';
      case 'input':
        switch (type) {
          case 'button':
          case 'submit':
          case 'reset':
          case 'image':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'range':
            return 'slider';
          case 'search':
            return 'searchbox';
          case 'hidden':
            return null;
          default:
            return 'textbox';
        }
      default:
        return null;
    }
  });

  /**
   * Rendered text for a name: what innerText shows, minus anything marked
   * aria-hidden, which the accessible name computation drops and a screen
   * reader never speaks (a required-field marker, a decorative icon's glyph).
   * A subtree without aria-hidden keeps innerText's layout-aware result.
   */
  const textOf = (el: Element): string => {
    if (!(el instanceof HTMLElement)) return el.textContent ?? '';
    if (el.querySelector('[aria-hidden="true"]') === null) return el.innerText;
    const clone = el.cloneNode(true) as HTMLElement;
    for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  /** Text owned directly by an element, excluding descendant elements. */
  const directTextOf = memoized((el: Element): string => {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  });

  const accessibleName = memoized((el: Element): string | null => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy !== null && labelledBy.trim() !== '') {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const target = el.ownerDocument.getElementById(id);
          return target === null ? '' : textOf(target);
        })
        .filter((part) => part.trim() !== '');
      if (parts.length > 0) return parts.join(' ').trim();
    }
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      const labels = (el as HTMLInputElement).labels;
      if (labels !== null && labels.length > 0) {
        const joined = Array.from(labels)
          .map((label) => textOf(label))
          .join(' ')
          .trim();
        if (joined !== '') return joined;
      }
    }
    if (el instanceof HTMLImageElement) {
      const alt = el.getAttribute('alt');
      if (alt !== null && alt.trim() !== '') return alt.trim();
    }
    const role = implicitRole(el);
    if (
      role === 'button' ||
      role === 'link' ||
      role === 'heading' ||
      role === 'tab' ||
      role === 'menuitem' ||
      role === 'option' ||
      role === 'listitem' ||
      role === 'status' ||
      role === 'alert'
    ) {
      const text = textOf(el).trim();
      if (text !== '') return text.replace(/\s+/g, ' ');
    }
    if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit')) {
      if (el.value.trim() !== '') return el.value.trim();
    }
    const title = el.getAttribute('title');
    if (title !== null && title.trim() !== '') return title.trim();
    return null;
  });

  /** Computed style, or undefined for a node the view cannot style. */
  const styleOf = (el: Element): CSSStyleDeclaration | undefined =>
    el instanceof HTMLElement ? el.ownerDocument.defaultView?.getComputedStyle(el) : undefined;

  const isHidden = (el: Element, style = styleOf(el)): boolean => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (!(el instanceof HTMLElement)) return el.getClientRects().length === 0;
    if (style !== undefined && (style.visibility === 'hidden' || style.display === 'none')) {
      return true;
    }
    return el.getClientRects().length === 0;
  };

  /** Smallest side, in CSS pixels, an empty box must have to be worth reporting. */
  const MIN_BOX_SIDE = 12;

  /** True when a computed style paints something a person can see. */
  const hasPaint = (style: CSSStyleDeclaration): boolean => {
    if (style.backgroundImage !== 'none' && style.backgroundImage !== '') return true;
    // A fully transparent color serializes with a zero alpha component.
    const background = style.backgroundColor;
    if (background !== '' && background !== 'transparent' && !/,\s*0\)$/.test(background)) {
      return true;
    }
    if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') return true;
    const sides = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    const styles = ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'];
    for (let index = 0; index < sides.length; index += 1) {
      const width = parseFloat(style[sides[index]! as 'borderTopWidth']);
      const kind = style[styles[index]! as 'borderTopStyle'];
      if (width > 0 && kind !== 'none' && kind !== 'hidden') return true;
    }
    return false;
  };

  /**
   * True when an element is an empty painted rectangle: no children, no text,
   * no role, no name — and yet plainly visible, because it has a border, an
   * outline, or a background of its own.
   *
   * This is the one element class defined by being empty. A drop zone, a canvas,
   * a chart placeholder, a colour swatch: a person sees a rectangle and can aim
   * at it, so a tree that omits it cannot describe the page it is describing.
   * `dragTo` in particular has no usable destination without it.
   *
   * The size floor and the paint requirement are what keep this from admitting
   * every layout div: a spacer, a clearfix, or a zero-alpha wrapper paints
   * nothing and is not something anyone can point at.
   */
  const isVisibleEmptyBox = memoized((el: Element): boolean => {
    const style = styleOf(el);
    if (style === undefined) return false;
    if (el.children.length > 0) return false;
    const explicit = (el.getAttribute('role') ?? '').trim();
    if (explicit !== '') return false;
    if (directTextOf(el) !== '') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_BOX_SIDE || rect.height < MIN_BOX_SIDE) return false;
    return hasPaint(style);
  });

  /**
   * Reduces a URL to origin and path, dropping userinfo, query, and fragment.
   * Bounded: hrefs are shown to the model as link hints, not resolved, so a
   * long path only buys tokens.
   */
  const HREF_LIMIT = 80;
  const originAndPath = (value: string, base: string): string => {
    try {
      const url = new URL(value, base);
      return `${url.origin}${url.pathname}`.slice(0, HREF_LIMIT);
    } catch {
      return (value.split('?')[0]?.split('#')[0] ?? '').slice(0, HREF_LIMIT);
    }
  };

  /** Attributes that name an element rather than describe where it sits. */
  const NAMING_ATTRIBUTES = [options.testIdAttribute, 'name'];

  /**
   * A document-unique attribute selector for one element, when it has one.
   *
   * A test ID names an element by definition; a form control's `name` names it
   * because the server reads it, which is also why it outlives redesigns. Ids
   * are deliberately absent: a framework that mints them per render
   * (`#firstName-aepj7PyFWSmXAkB8bb91h`) would make every selector single-use.
   */
  const namedSelectorOf = (el: Element): string | null => {
    for (const attribute of NAMING_ATTRIBUTES) {
      const value = el.getAttribute(attribute);
      if (value === null || value === '') continue;
      const selector = `[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`;
      let unique: boolean;
      try {
        unique = el.ownerDocument.querySelectorAll(selector).length === 1;
      } catch {
        continue;
      }
      if (unique) return selector;
    }
    return null;
  };

  /**
   * Path to one element in its own document, and whether anything along it names
   * the element rather than counting positions to it.
   *
   * The walk stops at the first ancestor something names, so an anchored path is
   * only positional *below* that ancestor. An unanchored path is positional all
   * the way from `body`, which makes it fragile for a reason that has nothing to
   * do with the element: a chat widget, a consent frame, or a portal appended
   * anywhere above shifts every `nth-child` index beneath it.
   *
   * Each `namedSelectorOf` probe is a document-wide `querySelectorAll`, so this
   * is deliberately not called for every node of a tree walk; see `projection`.
   */
  const pathTo = (el: Element): { selector: string; anchored: boolean } => {
    const named = namedSelectorOf(el);
    if (named !== null) return { selector: named, anchored: true };
    const parts: string[] = [];
    let current: Element | null = el;
    while (current !== null && current.tagName.toLowerCase() !== 'html') {
      const parent: Element | null = current.parentElement;
      if (parent === null) break;
      const index = Array.prototype.indexOf.call(parent.children, current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      const anchor = namedSelectorOf(parent);
      if (anchor !== null) return { selector: `${anchor} > ${parts.join(' > ')}`, anchored: true };
      current = parent;
    }
    return { selector: parts.join(' > '), anchored: false };
  };

  /**
   * The selector used to re-enter one iframe. Unanchored is fine here: it is
   * resolved against the document it was just read from, within this
   * observation, and never stored. This is the one place a selector is
   * derived: each `namedSelectorOf` probe is a document-wide query, and no
   * runner consumes a per-node selector, so neither read mode pays for one.
   */
  const frameSelectorOf = (el: Element): string => pathTo(el).selector;

  /**
   * The role both read modes report for one element.
   *
   * A tree walk and a single-node re-read have to agree: the runner acts on a
   * node it selected from an observation by re-reading that node and requiring
   * the same signature, so a role the walk invents and the re-read does not
   * makes the node unactionable. Anything the walk used to attach after the fact
   * belongs here instead.
   */
  const roleOf = (el: Element, tag: string): string | null => {
    const implicit = implicitRole(el);
    if (implicit !== null) return implicit;
    if (tag === 'iframe') return 'iframe';
    return isVisibleEmptyBox(el) ? 'box' : null;
  };

  const describe = (el: Element, style = styleOf(el)): RawNodeData => {
    const tag = el.tagName.toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();

    let value: string | null = null;
    let checked: boolean | null = null;
    let selectedState: boolean | null = null;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') checked = el.checked;
      else value = el.value;
    } else if (el instanceof HTMLTextAreaElement) {
      value = el.value;
    } else if (el instanceof HTMLSelectElement) {
      value = el.value;
    } else if (el instanceof HTMLOptionElement) {
      selectedState = el.selected;
      value = el.value;
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked !== null) checked = ariaChecked === 'true';
    const ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected !== null) selectedState = ariaSelected === 'true';

    const disabled =
      ((el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLButtonElement) &&
        el.disabled) ||
      el.getAttribute('aria-disabled') === 'true';

    const ariaExpanded = el.getAttribute('aria-expanded');
    // Matched against the shared selector rather than re-derived from tag and
    // type, so this node's `secure` flag and the screenshot mask agree by
    // construction.
    const secure = el.matches(options.secureFieldSelector);

    let inputPurpose: RawNodeData['inputPurpose'] = 'none';
    if (secure) inputPurpose = 'password';
    else if (autocomplete === 'username') inputPurpose = 'username';
    else if (autocomplete === 'current-password' || autocomplete === 'new-password') {
      inputPurpose = 'password';
    } else if (autocomplete === 'one-time-code') inputPurpose = 'one-time-code';

    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(el.attributes)) {
      if (
        projection.attributes === null ||
        projection.attributes.indexOf(attribute.name) !== -1 ||
        attribute.name.startsWith('aria-')
      ) {
        if (secure && attribute.name === 'value') continue;
        // Observations expose href origin and path only: query strings and
        // fragments routinely carry tokens.
        if (projection.redactHref && attribute.name === 'href') {
          attributes[attribute.name] = originAndPath(attribute.value, el.ownerDocument.baseURI);
          continue;
        }
        attributes[attribute.name] = attribute.value;
      }
    }

    let text: string;
    if (secure) text = '';
    else if (projection.directTextOnly) text = directTextOf(el);
    else text = textOf(el);
    if (projection.textLimit !== null) text = text.slice(0, projection.textLimit);

    let name = accessibleName(el);
    if (projection.nameLimit !== null && name !== null) name = name.slice(0, projection.nameLimit);
    const isDocumentRoot = projection.documentRoot && tag === 'html';
    if (isDocumentRoot) name = el.ownerDocument.title;

    const rect = el.getBoundingClientRect();

    return {
      role: isDocumentRoot ? 'document' : roleOf(el, tag),
      name,
      text,
      value: secure ? null : value,
      inputPurpose,
      states: {
        checked,
        disabled,
        selected: selectedState,
        expanded: ariaExpanded === null ? null : ariaExpanded === 'true',
        focused: el.ownerDocument.activeElement === el,
        hidden: isHidden(el, style),
        secure,
      },
      attributes,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };

  // The conditional return type resolves per call site; inside the body the
  // discriminant narrows the value but not the generic, hence the two casts.
  if (options.mode.kind === 'node') return describe(element) as SemanticResult<Mode>;

  const maxNodes = options.mode.maxNodes;
  const nodes: RawObservedNode[] = [];
  const elements: Element[] = [];
  const ids: string[] = [];
  let nextId = options.mode.idSeed;
  let truncated = false;

  // The id lives on the element itself under a registry symbol: invisible to
  // application code (no attribute, no enumerable property), gone with the
  // element, and readable by every later observation of the same document.
  const REF_KEY = Symbol.for('e2e.observation.ref');
  const stamp = (el: Element): string => {
    const carrier = el as Element & { [REF_KEY]?: string };
    let id = carrier[REF_KEY];
    if (id === undefined) {
      id = `n${String(nextId)}`;
      nextId += 1;
      carrier[REF_KEY] = id;
    }
    return id;
  };

  const include = (el: Element, parent: number, style = styleOf(el)): number => {
    const data = describe(el, style);
    nodes.push({ ...data, parent });
    elements.push(el);
    ids.push(stamp(el));
    return nodes.length - 1;
  };

  /** True when a node carries semantics worth sending to a model. */
  const isInteresting = (el: Element): boolean => {
    if (el.hasAttribute(options.testIdAttribute)) return true;
    const role = implicitRole(el);
    if (role !== null && role !== 'presentation' && role !== 'none') return true;
    if (accessibleName(el) !== null) return true;
    return directTextOf(el) !== '';
  };

  const walk = (el: Element, parent: number): void => {
    if (truncated) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.indexOf(tag) !== -1) return;
    // Read once and share: `isHidden` and the empty-box test both need it, and
    // this walk already pays one `getComputedStyle` per node.
    const style = styleOf(el);
    if (isHidden(el, style)) return;

    // Iframes are emitted as boundary nodes and never entered: their content
    // lives in another document, which the engine captures per frame and
    // stitches under this node.
    if (tag === 'iframe') {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      const index = include(el, parent, style);
      const node = nodes[index]!;
      node.frameSelector = frameSelectorOf(el);
      if (node.name === null) {
        const title = el.getAttribute('title');
        if (title !== null && title.trim() !== '') node.name = title.trim();
      }
      return;
    }

    let nextParent = parent;
    // An empty painted rectangle carries no semantics to be "interesting" by and
    // is still something a person sees and aims at; `roleOf` names it `box`.
    if (isInteresting(el) || isVisibleEmptyBox(el)) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      nextParent = include(el, parent, style);
    }
    // A closed select paints none of its options, so the hidden test would
    // drop every one of them — and a model shown `combobox "Category"` alone
    // has to guess the labels it may pick. The options are what the control
    // offers, so they are listed under it, bounded like any long list.
    if (tag === 'select') {
      const choices = Array.from((el as HTMLSelectElement).options).slice(0, MAX_SELECT_OPTIONS);
      for (const option of choices) {
        if (nodes.length >= maxNodes) {
          truncated = true;
          return;
        }
        const index = include(option, nextParent, styleOf(option));
        const node = nodes[index]!;
        // Listed on purpose, so not "hidden"; the label is the name and the
        // value attribute is the app's internal token, not something to show.
        node.states.hidden = false;
        node.value = null;
      }
      return;
    }
    if (OPAQUE_TAGS.indexOf(tag) !== -1) return;
    for (const child of Array.from(el.children)) walk(child, nextParent);
    // An open shadow root is part of what the user sees, so it is part of what
    // the model is shown. Walking the host's light children and its shadow tree
    // double-counts nothing: slotted elements are light children, and the shadow
    // tree holds the `<slot>` placeholders rather than copies of them. A closed
    // root is not reachable from script, so it stays invisible — the same as for
    // a person reading the page.
    const shadow = el.shadowRoot;
    if (shadow !== null) {
      for (const child of Array.from(shadow.children)) walk(child, nextParent);
    }
  };

  include(element, -1);
  for (const child of Array.from(element.children)) walk(child, 0);

  return { nodes, elements, ids, nextId } as SemanticResult<Mode>;
};

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
