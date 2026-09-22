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

/**
 * Where the init script below records closed shadow roots, keyed by host, and
 * where the in-page reader looks for them. The reader is serialized into the
 * page and cannot import this constant, so the literal is repeated inside it;
 * the two must agree, like `SECURE_FIELD_SELECTOR` on both sides of masking.
 */
export const CLOSED_SHADOW_ROOTS_KEY = 'e2e.closedShadowRoots';

/**
 * Context init script that keeps every closed shadow root reachable for the
 * reader. A closed root hides its tree from `element.shadowRoot`, so a checkout
 * button a third-party widget renders that way is on screen for a person yet
 * absent from the walk. `attachShadow` is the one way a script creates such a
 * root; wrapping it before any page script runs records host and root in a
 * WeakMap under a well-known symbol, which the reader consults where it reads
 * `shadowRoot`. The map is keyed by the host element and never enumerated, so
 * it holds nothing alive and changes nothing the page can observe about the
 * root itself. Declarative `<template shadowrootmode="closed">` roots are
 * parsed rather than attached and stay out of reach.
 */
export const CLOSED_SHADOW_ROOTS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  const roots = new WeakMap();
  Object.defineProperty(globalThis, key, { value: roots, enumerable: false, configurable: false, writable: false });
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    if (root.mode === 'closed') roots.set(this, root);
    return root;
  };
})();`;

/** Playwright selector engine name; `e2e-closed=<css>` matches inside recorded closed shadow roots. */
export const CLOSED_SHADOW_SELECTOR_ENGINE = 'e2e-closed';

/**
 * The engine behind `e2e-closed=<css>`: every element matching the CSS
 * selector inside a closed shadow root the init script recorded, reached from
 * the query root through light DOM and open roots, and through roots of either
 * kind nested below a closed one. Playwright's own selectors stop at a closed
 * root, so this is what lets a screenshot mask cover a secure field the reader
 * now reports there. It runs in the page's main world (not as a content
 * script) because that is where the record lives.
 */
export const CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE = `() => {
  const roots = globalThis[Symbol.for(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)})];
  const closedRootsUnder = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      const closed = roots.get(el);
      if (closed !== undefined) out.push(closed);
      if (el.shadowRoot !== null) closedRootsUnder(el.shadowRoot, out);
    }
    return out;
  };
  const matchesIn = (root, selector, out) => {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      const nested = el.shadowRoot !== null ? el.shadowRoot : roots.get(el);
      if (nested !== undefined && nested !== null) matchesIn(nested, selector, out);
    }
    return out;
  };
  const queryAll = (root, selector) => {
    if (!(roots instanceof WeakMap)) throw new Error('closed-shadow root tracking is unavailable for this document');
    const out = [];
    for (const closed of closedRootsUnder(root, [])) matchesIn(closed, selector, out);
    return out;
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;

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
  /** `aria-hidden` when that, on the element or an ancestor, is what hides it; null otherwise. */
  hiddenBy: 'aria-hidden' | null;
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

type SemanticMode =
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
  /**
   * Tags a `contenteditable` never makes an editing host. A drawn or embedded
   * surface and a void element hold no DOM text to edit; a native control (a
   * link, a button, a form field) has a role and a value of its own, so a fill
   * reaches it as what it is. Chromium reports `isContentEditable` on all of
   * them regardless.
   */
  const NON_HOST_TAGS = [...OPAQUE_TAGS, 'iframe', 'img', 'hr', 'br', 'wbr', 'area', 'a', 'button', 'input', 'textarea', 'select'];
  /** Options listed under one select; a country picker's tail is not worth the tokens. */
  const MAX_SELECT_OPTIONS = 60;
  /** Input types whose accessible name falls back to the placeholder (HTML-AAM 4.1.1). */
  const PLACEHOLDER_NAMED_INPUT_TYPES = ['text', 'password', 'number', 'search', 'tel', 'email', 'url'];

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
          attributes: ['type', 'autocomplete', 'href', 'role', 'placeholder'],
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

  /**
   * True when an element carries a name of its own (HTML-AAM: `aria-label`,
   * `aria-labelledby`, or `title`). A `<form>` or `<section>` is a landmark
   * only when named; unnamed, it is a plain container.
   */
  const hasOwnName = (el: Element): boolean =>
    ['aria-label', 'aria-labelledby', 'title'].some((attribute) => (el.getAttribute(attribute) ?? '').trim() !== '');

  /**
   * True when a `<header>` or `<footer>` is the page's, not an article's or a
   * section's: only then is it the `banner` or `contentinfo` landmark.
   */
  const isPageLevel = (el: Element): boolean => el.closest('article, aside, main, nav, section') === null;

  /**
   * The root of a contenteditable region: editable itself, under a parent that
   * is not. A rich-text editor (ProseMirror, TipTap, Lexical, Slate) renders
   * its document as such a host with block children; the host is the control
   * a person types into and the blocks are its content, so only the host is a
   * textbox, whatever its tag: an `<article contenteditable>` is the editor,
   * not an article. A canvas made editable to collect keystrokes is a drawn
   * field the keyboard reaches, not a textbox; see `NON_HOST_TAGS`.
   */
  const isEditingHost = (el: Element): boolean =>
    el instanceof HTMLElement &&
    el.isContentEditable &&
    NON_HOST_TAGS.indexOf(el.tagName.toLowerCase()) === -1 &&
    !(el.parentElement instanceof HTMLElement && el.parentElement.isContentEditable);

  const implicitRole = memoized((el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit !== null && explicit !== '') {
      const first = explicit.split(/\s+/)[0] ?? null;
      // The vocabulary spells ARIA's `img` as `image`.
      return first === 'img' ? 'image' : first;
    }
    // Ahead of the tag: an editor's host is the control, whatever landmark or
    // structure its tag would otherwise be.
    if (isEditingHost(el)) return 'textbox';
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
      case 'aside':
        return 'complementary';
      case 'header':
        return isPageLevel(el) ? 'banner' : null;
      case 'footer':
        return isPageLevel(el) ? 'contentinfo' : null;
      case 'section':
        return hasOwnName(el) ? 'region' : null;
      case 'form':
        return hasOwnName(el) ? 'form' : null;
      case 'article':
        return 'article';
      case 'figure':
        return 'figure';
      case 'hr':
        return 'separator';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      // HTML-AAM: `<menu>` is a list; only `role="menu"` is a menu.
      case 'menu':
        return 'list';
      case 'fieldset':
      case 'details':
      case 'optgroup':
      case 'address':
        return 'group';
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
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return 'rowgroup';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th': {
        const scope = (el.getAttribute('scope') ?? '').toLowerCase();
        return scope === 'row' || scope === 'rowgroup' ? 'rowheader' : 'columnheader';
      }
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
          case 'number':
            return 'spinbutton';
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

  /** Rendered text as a person sees it: innerText, aria-hidden glyphs included. */
  const textOf = (el: Element): string => {
    if (el instanceof HTMLElement) return el.innerText;
    return el.textContent ?? '';
  };

  /**
   * State of one accname walk. `inReference` is set inside an aria-labelledby
   * traversal, where a nested reference is not followed (accname 2B);
   * `hiddenAllowed` when that traversal began at a hidden target, whose whole
   * subtree then counts (2A); `visited` holds every element already read, so a
   * descendant that references its ancestor, or two that reference each other,
   * contribute once.
   */
  interface NameWalk {
    readonly inReference: boolean;
    readonly hiddenAllowed: boolean;
    readonly visited: Set<Element>;
  }

  /** A walk from the top, with the elements that may not contribute again already visited. */
  const nameWalk = (visited: readonly Element[]): NameWalk => ({
    inReference: false,
    hiddenAllowed: false,
    visited: new Set(visited),
  });

  /** Computed style of any element, SVG included: what the name computation's hidden and block tests read. */
  const nameStyleOf = (el: Element): CSSStyleDeclaration | undefined =>
    el.ownerDocument.defaultView?.getComputedStyle(el);

  /** True for a subtree the name computation drops: aria-hidden, or hidden by style as innerText leaves it out. */
  const isNameHidden = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    el.getAttribute('aria-hidden') === 'true' ||
    (style !== undefined && (style.display === 'none' || style.visibility === 'hidden'));

  /** `alt` of an element HTML-AAM names by it: an `<img>` or an `<input type="image">`. */
  const altOf = (el: Element): string | null => {
    const named = el instanceof HTMLImageElement || (el instanceof HTMLInputElement && el.type === 'image');
    const alt = named ? el.getAttribute('alt') : null;
    return alt !== null && alt.trim() !== '' ? alt.trim() : null;
  };

  /**
   * Each aria-labelledby target's contribution (accname 2B), in attribute
   * order, unnamed targets dropped; null when the element references nothing
   * that names it. A hidden target is read whole, as a screen reader reads it,
   * and a reference inside a target is not followed, so this is null inside a
   * reference traversal too.
   */
  const referencedNamesOf = (el: Element, walk: NameWalk): string[] | null => {
    if (walk.inReference) return null;
    const ids = (el.getAttribute('aria-labelledby') ?? '').trim();
    if (ids === '') return null;
    const names: string[] = [];
    for (const id of ids.split(/\s+/)) {
      const target = el.ownerDocument.getElementById(id);
      if (target === null) continue;
      const name = contentNameOf(target, nameStyleOf(target), {
        inReference: true,
        hiddenAllowed: isHidden(target),
        visited: walk.visited,
      })
        .replace(/\s+/g, ' ')
        .trim();
      if (name !== '') names.push(name);
    }
    return names.length === 0 ? null : names;
  };

  /**
   * What one element contributes to a name computed through another: as an
   * aria-labelledby target (accname 2B) or as a descendant read for name from
   * content (2F). Its own references, else its `aria-label`, its `alt`, its
   * children, then its `title`. So `<button><img alt="Search"></button>` is
   * the button "Search", an icon whose only child is
   * `<svg aria-labelledby="t"><title id="t">Close</title></svg>` is "Close",
   * and a hidden `<span>` a button references still names it. A form
   * control's content is its value, not label text, so it contributes nothing.
   */
  const contentNameOf = (el: Element, style: CSSStyleDeclaration | undefined, walk: NameWalk): string => {
    if (walk.visited.has(el)) return '';
    walk.visited.add(el);
    if (!walk.hiddenAllowed && isNameHidden(el, style)) return '';
    const referenced = referencedNamesOf(el, walk);
    if (referenced !== null) return referenced.join(' ');
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const alt = altOf(el);
    if (alt !== null) return alt;
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    const content = childrenNameOf(el, walk);
    if (content.trim() !== '') return content;
    const title = el.getAttribute('title');
    return title === null ? '' : title.trim();
  };

  /**
   * The children's contributions joined as Playwright's role selector joins
   * them: a space on each side of a block-level child and of a `<br>`, none
   * around an inline one. `<img alt="Search">Go` reads "SearchGo" and
   * `<div>A</div><div>B</div>` reads "A B", so the name a role query matched
   * is the name the node reports.
   */
  const childrenNameOf = (el: Element, walk: NameWalk): string => {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? '';
        continue;
      }
      if (!(child instanceof Element)) continue;
      const style = nameStyleOf(child);
      const token = contentNameOf(child, style, walk);
      const block = child.tagName === 'BR' || (style?.display ?? 'inline') !== 'inline';
      out += block ? ` ${token} ` : token;
    }
    return out;
  };

  /**
   * Text for an accessible name from an element's own content (accname 2F):
   * its descendants' contributions, hidden and aria-hidden subtrees dropped (a
   * required-field marker, a decorative glyph), whitespace collapsed. The
   * element's own attributes are `accessibleName`'s business; this reads what
   * is inside it.
   */
  const nameTextOf = (el: Element): string => {
    if (isNameHidden(el, nameStyleOf(el))) return '';
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    return childrenNameOf(el, nameWalk([el])).replace(/\s+/g, ' ').trim();
  };

  const NAME_OPAQUE_TAGS: ReadonlySet<string> = new Set(['TEXTAREA', 'SELECT', 'INPUT', 'SCRIPT', 'STYLE']);

  /** HTML-AAM: the child element that names its parent when nothing ARIA does. */
  const NAMING_CHILD_TAGS: Readonly<Record<string, string>> = { fieldset: 'legend', figure: 'figcaption', table: 'caption' };

  /** The `<label>` elements associated with a labelable element (button, input, meter, output, progress, select, textarea). */
  const associatedLabels = (el: Element): readonly HTMLLabelElement[] => {
    const labels = (el as Element & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
    return labels === undefined || labels === null ? [] : Array.from(labels);
  };

  /** The label sources an exact label query may match; see `RawNodeData.labels`. */
  const labelsOf = (el: Element): string[] | null => {
    const labels: string[] = [];
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') labels.push(ariaLabel.trim());
    for (const name of referencedNamesOf(el, nameWalk([])) ?? []) labels.push(name);
    for (const label of associatedLabels(el)) {
      const text = nameTextOf(label);
      if (text !== '') labels.push(text);
    }
    return labels.length === 0 ? null : labels;
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
    // accname reads a labelledby reference (2B) before the element's own aria-label (2C).
    const referenced = referencedNamesOf(el, nameWalk([]));
    if (referenced !== null) return referenced.join(' ');
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const labels = associatedLabels(el);
    if (labels.length > 0) {
      const joined = labels
        .map((label) => nameTextOf(label))
        .join(' ')
        .trim();
      if (joined !== '') return joined;
    }
    const alt = altOf(el);
    if (alt !== null) return alt;
    const captionTag = NAMING_CHILD_TAGS[el.tagName.toLowerCase()];
    if (captionTag !== undefined) {
      const caption = Array.from(el.children).find((child) => child.tagName.toLowerCase() === captionTag);
      const text = caption === undefined ? '' : nameTextOf(caption);
      if (text !== '') return text;
    }
    const role = implicitRole(el);
    if (
      role === 'button' ||
      role === 'link' ||
      role === 'heading' ||
      role === 'tab' ||
      role === 'menuitem' ||
      role === 'menuitemcheckbox' ||
      role === 'menuitemradio' ||
      role === 'treeitem' ||
      role === 'tooltip' ||
      role === 'option' ||
      role === 'listitem' ||
      role === 'status' ||
      role === 'alert'
    ) {
      const text = nameTextOf(el);
      if (text !== '') return text;
    }
    if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit')) {
      if (el.value.trim() !== '') return el.value.trim();
    }
    const title = el.getAttribute('title');
    if (title !== null && title.trim() !== '') return title.trim();
    // HTML-AAM names an unlabeled text control by its placeholder, after the
    // title: a bare search box is `textbox "Search…"`, not an anonymous field.
    if (isPlaceholderNamed(el)) {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();
      const ariaPlaceholder = el.getAttribute('aria-placeholder');
      if (ariaPlaceholder !== null && ariaPlaceholder.trim() !== '') return ariaPlaceholder.trim();
      if (isEditingHost(el)) return editorPlaceholderOf(el);
    }
    return null;
  });

  /**
   * The controls a placeholder may name: text-like inputs and textareas
   * (HTML-AAM 4.1.1), and the textbox and searchbox roles `aria-placeholder`
   * applies to, an editing host among them.
   */
  const isPlaceholderNamed = (el: Element): boolean => {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return PLACEHOLDER_NAMED_INPUT_TYPES.indexOf(el.type) !== -1;
    const role = implicitRole(el);
    return role === 'textbox' || role === 'searchbox';
  };

  /**
   * The placeholder a rich-text editor paints from `data-placeholder`, the one
   * convention its frameworks share: Quill sets it on the host; ProseMirror
   * and TipTap set it on the first empty block and drop it once the document
   * has content, as the painted hint goes.
   */
  const editorPlaceholderOf = (host: Element): string | null => {
    const own = host.getAttribute('data-placeholder');
    if (own !== null && own.trim() !== '') return own.trim();
    for (const block of Array.from(host.querySelectorAll('[data-placeholder]'))) {
      if ((block.textContent ?? '').trim() !== '') continue;
      const placeholder = block.getAttribute('data-placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();
    }
    return null;
  };

  /** Computed style, or undefined for a node the view cannot style. */
  const styleOf = (el: Element): CSSStyleDeclaration | undefined =>
    el instanceof HTMLElement ? el.ownerDocument.defaultView?.getComputedStyle(el) : undefined;

  /**
   * Closed shadow roots the context's init script recorded, when it ran in this
   * document. Same literal as `CLOSED_SHADOW_ROOTS_KEY`; the reader cannot import it.
   */
  const closedShadowRoots = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[
    Symbol.for('e2e.closedShadowRoots')
  ];
  const shadowRootOf = (el: Element): ShadowRoot | null =>
    el.shadowRoot ?? closedShadowRoots?.get(el) ?? null;

  /**
   * True when `aria-hidden="true"` on the element or an ancestor excludes it
   * from the accessibility tree. Shadow hosts count as ancestors, as the walk
   * that skips a hidden subtree never enters a hidden host's shadow tree, so
   * a single-node read agrees with it for every element.
   */
  const isAriaHidden = (el: Element): boolean => {
    for (let current: Element | null = el; current !== null; ) {
      if (current.closest('[aria-hidden="true"]') !== null) return true;
      const root = current.getRootNode();
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  };

  /** True when layout keeps the element off screen: `display`, `visibility`, or no box. */
  const isLayoutHidden = (el: Element, style = styleOf(el)): boolean => {
    if (!(el instanceof HTMLElement)) return el.getClientRects().length === 0;
    if (style !== undefined && (style.visibility === 'hidden' || style.display === 'none')) {
      return true;
    }
    // `display: contents` generates no box of its own while every child still
    // paints (Shopify's one-page checkout form is one), so an empty rect list
    // says nothing about what a person sees; the children decide for themselves.
    if (style !== undefined && style.display === 'contents') return false;
    return el.getClientRects().length === 0;
  };

  /** The one visibility predicate: the walk skips what it calls hidden, a node read reports it. */
  const isHidden = (el: Element, style = styleOf(el)): boolean => isAriaHidden(el) || isLayoutHidden(el, style);

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
    } else if (isEditingHost(el)) {
      // An editor's document is its value, as a textarea's text is: trimmed,
      // since an empty editor renders `<p><br></p>` and innerText reads that
      // as a newline, and cut like text in the model-bound projection.
      value = textOf(el).trim();
      if (projection.textLimit !== null) value = value.slice(0, projection.textLimit);
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
    const ariaPressed = el.getAttribute('aria-pressed');
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
    // A secure field withholds its value, never its labels: a password field is still found by its label.
    const labels = labelsOf(el);
    const isDocumentRoot = projection.documentRoot && tag === 'html';
    if (isDocumentRoot) name = el.ownerDocument.title;

    const rect = el.getBoundingClientRect();
    const role = isDocumentRoot ? 'document' : roleOf(el, tag);
    let level: number | null = null;
    if (role === 'heading') {
      const ariaLevel = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
      if (Number.isInteger(ariaLevel) && ariaLevel > 0) level = ariaLevel;
      else if (/^h[1-6]$/.test(tag)) level = Number(tag.slice(1));
      // HTML-AAM: a role="heading" element with no aria-level is level 2.
      else level = 2;
    }

    const ariaHidden = isAriaHidden(el);
    return {
      role,
      name,
      labels,
      text,
      value: secure ? null : value,
      inputPurpose,
      states: {
        checked,
        disabled,
        selected: selectedState,
        expanded: ariaExpanded === null ? null : ariaExpanded === 'true',
        pressed: ariaPressed === null ? null : ariaPressed === 'true',
        focused: el.ownerDocument.activeElement === el,
        hidden: ariaHidden || isLayoutHidden(el, style),
        secure,
      },
      hiddenBy: ariaHidden ? 'aria-hidden' : null,
      level,
      attributes,
      testId: el.getAttribute(options.testIdAttribute),
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
        node.hiddenBy = null;
        node.value = null;
      }
      return;
    }
    if (OPAQUE_TAGS.indexOf(tag) !== -1) return;
    for (const child of Array.from(el.children)) walk(child, nextParent);
    // A shadow root is part of what the user sees, so it is part of what the
    // model is shown. Walking the host's light children and its shadow tree
    // double-counts nothing: slotted elements are light children, and the shadow
    // tree holds the `<slot>` placeholders rather than copies of them. A closed
    // root is unreachable from `shadowRoot`, so it comes from the record the
    // context's init script kept when the page attached it.
    const shadow = shadowRootOf(el);
    if (shadow !== null) {
      for (const child of Array.from(shadow.children)) walk(child, nextParent);
    }
  };

  include(element, -1);
  for (const child of Array.from(element.children)) walk(child, 0);

  return { nodes, elements, ids, truncated } as SemanticResult<Mode>;
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

/**
 * The batch reader for `page.evaluate`, which takes one argument: the element
 * handles the caller already holds, so what is read and what is later acted
 * on are the same elements by construction rather than by a second lookup.
 */
/**
 * Reads every handle in one round trip. Evaluated on the first handle so the read runs in the
 * frame the handles belong to; `page.evaluate` would reject handles taken inside an iframe.
 */
export const readHandlesSemanticsFunction = new Function(
  '_first',
  'arg',
  `return arg.elements.map((element) => (${readSemanticsFunction.toString()})(element, arg.options));`,
) as (first: Element, arg: { elements: Element[]; options: NodeReadOptions }) => RawNodeData[];
