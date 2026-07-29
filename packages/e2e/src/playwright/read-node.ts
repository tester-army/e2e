/** In-page semantic reader executed via locator.evaluate / locator.evaluateHandle. */

/**
 * The one definition of a secure field.
 *
 * It is a selector rather than a predicate because it has to be applied from
 * two sides that cannot share code: the in-page reader matches elements
 * against it to mark nodes `secure`, and the driver hands the same string to
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
 * One walked document. driver-1 has no way to report a truncated tree, so the
 * node budget is a safety valve, not a signal: when it stops the walk early
 * the result simply ends, and the runner's visible observation byte budget is
 * the effective limit.
 */
export interface RawObservation {
  nodes: RawObservedNode[];
  /** Live element handles positionally aligned with `nodes`. */
  elements: Element[];
  secureNodeCount: number;
}

export type SemanticMode =
  | { kind: 'node' }
  | {
      kind: 'tree';
      maxNodes: number;
      /** Cuts each node's name at this length; the caller owns the contract value. */
      nameLimit: number;
      /** Cuts each node's text at this length; the caller owns the contract value. */
      textLimit: number;
    };

export interface SemanticOptions {
  testIdAttribute: string;
  mode: SemanticMode;
}

/** Result of one read, selected by the mode discriminant. */
export type SemanticResult<Mode extends SemanticMode> = Mode extends { kind: 'node' }
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
export const readSemanticsFunction = <Mode extends SemanticMode>(
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
   * How the active mode projects one node, expressed as data so `describe`
   * stays branch-free. Tree mode is the model-bound projection: bounded text,
   * a lean attribute allowlist, hrefs reduced to origin+path, and the root
   * document named by its title. Node mode is the full locator-read surface.
   */
  const projection =
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
          attributes: [
            options.testIdAttribute,
            'type',
            'autocomplete',
            'href',
            'role',
            'id',
            'name',
            'placeholder',
            'title',
            'alt',
            'value',
          ],
          textLimit: null,
          nameLimit: null,
          redactHref: false,
          directTextOnly: false,
          documentRoot: false,
        };

  const implicitRole = (el: Element): string | null => {
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
  };

  const textOf = (el: Element): string => {
    if (el instanceof HTMLElement) return el.innerText;
    return el.textContent ?? '';
  };

  /** Text owned directly by an element, excluding descendant elements. */
  const directTextOf = (el: Element): string => {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  const accessibleName = (el: Element): string | null => {
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
  };

  const isHidden = (el: Element): boolean => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (!(el instanceof HTMLElement)) return el.getClientRects().length === 0;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style !== undefined && (style.visibility === 'hidden' || style.display === 'none')) {
      return true;
    }
    return el.getClientRects().length === 0;
  };

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

  const describe = (el: Element): RawNodeData => {
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
      if (projection.attributes.indexOf(attribute.name) !== -1 || attribute.name.startsWith('aria-')) {
        if (secure && attribute.name === 'value') continue;
        // Observations expose href origin and path only: query strings and
        // fragments routinely carry tokens (spec 10-determinism.md).
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
      role: isDocumentRoot ? 'document' : implicitRole(el),
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
        hidden: isHidden(el),
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
  let truncated = false;
  let secureNodeCount = 0;

  const include = (el: Element, parent: number): number => {
    const data = describe(el);
    if (data.states.secure) secureNodeCount += 1;
    nodes.push({ ...data, parent });
    elements.push(el);
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

  /** Unique CSS selector for one iframe element in its own document. */
  const frameSelectorOf = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id !== null && id !== '' && el.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      return `#${CSS.escape(id)}`;
    }
    const parts: string[] = [];
    let current: Element | null = el;
    while (current !== null && current.tagName.toLowerCase() !== 'html') {
      const parent: Element | null = current.parentElement;
      if (parent === null) break;
      const index = Array.prototype.indexOf.call(parent.children, current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(' > ');
  };

  const walk = (el: Element, parent: number): void => {
    if (truncated) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.indexOf(tag) !== -1) return;
    if (isHidden(el)) return;

    // Iframes are emitted as boundary nodes and never entered: their content
    // lives in another document, which the driver captures per frame and
    // stitches under this node.
    if (tag === 'iframe') {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      const index = include(el, parent);
      const node = nodes[index]!;
      node.frameSelector = frameSelectorOf(el);
      node.role = 'iframe';
      if (node.name === null) {
        const title = el.getAttribute('title');
        if (title !== null && title.trim() !== '') node.name = title.trim();
      }
      return;
    }

    let nextParent = parent;
    if (isInteresting(el)) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return;
      }
      nextParent = include(el, parent);
    }
    if (OPAQUE_TAGS.indexOf(tag) !== -1) return;
    for (const child of Array.from(el.children)) walk(child, nextParent);
  };

  include(element, -1);
  for (const child of Array.from(element.children)) walk(child, 0);

  return { nodes, elements, secureNodeCount } as SemanticResult<Mode>;
};
