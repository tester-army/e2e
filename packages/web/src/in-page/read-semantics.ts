/**
 * The in-page semantic reader. Playwright serializes it with `toString()` and
 * runs it inside the page (`read-node.ts` assembles the three page functions
 * from its source), so it must stay one self-contained function: no imports
 * beyond types, no module-scope references, every constant inside the body.
 * That is why it has a file of its own.
 */

import type { RawNodeData, RawObservedNode, SemanticMode, SemanticResult } from '../read-node.ts';

/**
 * Serialized into the page by Playwright. Must stay self-contained: no outer
 * captures beyond its two arguments.
 *
 * `mode.kind === 'node'` reads exactly one element for locator reads, in
 * the selector engine's task that found it (`read-selector.ts`,
 * `label-selector.ts`), so the element is always in its document.
 * `mode.kind === 'hidden'` answers that one element's `states.hidden` alone.
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
   * stays branch-free. Tree mode is the model-bound projection: bounded line
   * text (`lineTextOf`), a bounded attribute projection, hrefs reduced to
   * origin+path, the root document named by its title, and no value on a
   * checkbox or radio, whose value attribute is an app token its checked
   * state already says more than. Node mode is the full locator-read surface.
   */
  const projection: {
    attributes: readonly string[] | null;
    textLimit: number | null;
    nameLimit: number | null;
    redactHref: boolean;
    lineText: boolean;
    documentRoot: boolean;
    checkableValue: boolean;
  } =
    options.mode.kind === 'tree'
      ? {
          attributes: ['type', 'autocomplete', 'href', 'role', 'placeholder'],
          textLimit: options.mode.textLimit,
          nameLimit: options.mode.nameLimit,
          redactHref: true,
          lineText: true,
          documentRoot: true,
          checkableValue: false,
        }
      : {
          attributes: null,
          textLimit: null,
          nameLimit: null,
          redactHref: false,
          lineText: false,
          documentRoot: false,
          checkableValue: true,
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

  /** Concrete WAI-ARIA roles, excluding abstract roles that cannot label an element. */
  const ARIA_ROLES = [
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
    'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition',
    'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form',
    'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link',
    'list', 'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math',
    'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none',
    'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region',
    'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
    'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
    'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip',
    'tree', 'treegrid', 'treeitem',
  ];
  /** ARIA uses the first recognized token, then native semantics if none is recognized. */
  const explicitRole = memoized((el: Element): string | null =>
    (el.getAttribute('role') ?? '').split(/[ \t\n\f\r]+/).find((role) => ARIA_ROLES.indexOf(role) !== -1) ?? null);

  /**
   * True when an element carries a name of its own (HTML-AAM: `aria-label`,
   * `aria-labelledby`, or `title`). A `<form>` or `<section>` is a landmark
   * only when named; unnamed, it is a plain container.
   */
  const hasOwnName = (el: Element): boolean =>
    ['aria-label', 'aria-labelledby', 'title'].some((attribute) => (el.getAttribute(attribute) ?? '').trim() !== '');

  const SECTIONING_SCOPE = [
    'article', 'aside', 'main', 'nav', 'section',
    ...['article', 'complementary', 'main', 'navigation', 'region'].map((role) => `[role~="${role}"]`),
  ].join(', ');

  /**
   * True when a `<header>` or `<footer>` is the page's, not an article's or a
   * section's: only then is it the `banner` or `contentinfo` landmark.
   * HTML-AAM scopes it to sectioning content and to the ARIA roles that stand
   * for it, so a `<div role="article">` scopes it like an `<article>`.
   */
  const isPageLevel = (el: Element): boolean => {
    for (let candidate: Element | null = el; candidate !== null;) {
      if (candidate.closest(SECTIONING_SCOPE) !== null) return false;
      const root = candidate.getRootNode();
      candidate = root instanceof ShadowRoot ? root.host : null;
    }
    return true;
  };

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
    const explicit = explicitRole(el);
    if (explicit !== null) {
      // The vocabulary spells ARIA's `img` as `image`.
      return explicit === 'img' ? 'image' : explicit;
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
      // HTML-AAM: a select that shows several rows is a listbox; only a
      // one-row drop-down is a combobox.
      case 'select':
        return el.hasAttribute('multiple') || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return el.getAttribute('alt') === '' ? 'presentation' : 'image';
      // An inline icon is a picture whether or not anything names it, as
      // Playwright reads it; Chrome ignores an unnamed one.
      case 'svg':
        return 'image';
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
      // A grid's cells are the interactive kind, as Playwright reads them.
      case 'td': {
        const table = el.closest('table');
        const tableRole = table === null ? null : explicitRole(table);
        return tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';
      }
      case 'th': {
        const scope = (el.getAttribute('scope') ?? '').toLowerCase();
        if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
        if (scope === 'col' || scope === 'colgroup') return 'columnheader';
        const previous = el.previousElementSibling;
        const next = el.nextElementSibling;
        if (previous === null && next === null) {
          const row = el.parentElement;
          const table = row?.tagName.toLowerCase() === 'tr' ? row.closest('table') : null;
          return table !== null && (table as HTMLTableElement).rows.length <= 1 ? null : 'columnheader';
        }
        if (previous?.tagName.toLowerCase() === 'th' && next?.tagName.toLowerCase() === 'th') return 'columnheader';
        const hasDataNeighbor = [previous, next].some((cell) =>
          cell?.tagName.toLowerCase() === 'td' && ((cell.textContent ?? '').trim() !== '' || cell.children.length > 0));
        return hasDataNeighbor ? 'rowheader' : 'columnheader';
      }
      case 'dialog':
        return 'dialog';
      case 'output':
        return 'status';
      case 'input':
        // HTML-AAM: a text field with suggestions from a datalist is a combobox.
        // `list` resolves the attribute to a datalist element, null for anything else.
        // The `type` property, not the attribute: a type the browser does not know is `text`.
        if ((el as HTMLInputElement).list !== null && ['text', 'search', 'tel', 'url', 'email'].indexOf((el as HTMLInputElement).type) !== -1) return 'combobox';
        switch (type) {
          case 'button':
          case 'submit':
          case 'reset':
          case 'image':
          // A file input is its picker button, as Chrome and Playwright read it.
          case 'file':
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
   * contribute once. `accessible` is set for an accessible name, which reads
   * CSS generated content (`::before`, `::after`) and an embedded control's
   * value as accname does, and unset for label text, which Playwright's
   * `getByLabel` reads without either.
   */
  interface NameWalk {
    readonly inReference: boolean;
    readonly hiddenAllowed: boolean;
    readonly visited: Set<Element>;
    readonly accessible: boolean;
  }

  /** Computed style of any element, SVG included, or undefined in a document with no view. */
  const styleOf = (el: Element): CSSStyleDeclaration | undefined =>
    el.ownerDocument.defaultView?.getComputedStyle(el);

  /** A walk from the top, with the elements that may not contribute again already visited. */
  const nameWalk = (visited: readonly Element[], accessible: boolean): NameWalk => ({
    inReference: false,
    hiddenAllowed: false,
    visited: new Set(visited),
    accessible,
  });

  /**
   * Private-use code points: icon-font glyphs (Font Awesome's `\f090`) that
   * render as a picture and read as nothing a person could type. Each one
   * becomes a space once a name is computed, so `<button><i class="fa
   * fa-sign-in"></i> Login</button>` is the button "Login" and the role
   * locator, which tolerates them where a name has a space or begins or
   * ends, finds it by that.
   */
  const ICON_GLYPHS = /\p{Co}/gu;

  /** A computed name or label as the tree reports it: each icon glyph a space, whitespace collapsed. */
  const withoutGlyphs = (name: string): string => {
    const spaced = name.replace(ICON_GLYPHS, ' ');
    return spaced === name ? name : spaced.replace(/\s+/g, ' ').trim();
  };

  /**
   * An element's name as the tree reports it. A name of icon glyphs alone
   * (`<button title="Delete"><i class="fa fa-trash"></i></button>`, which the
   * browser names by the glyph) falls back to the element's `title`, the
   * word a person hovering it reads, else to no name.
   */
  const reportedName = (el: Element, name: string | null): string | null => {
    if (name === null) return null;
    const shown = withoutGlyphs(name);
    if (shown !== '' || shown === name) return shown;
    const title = (el.getAttribute('title') ?? '').trim();
    return title === '' ? null : title;
  };

  /**
   * The text a `content` value contributes, as Playwright's role selector
   * reads it: its strings and `attr()` values, or only the alternative text
   * after a `/`. Contributing anything else (an image, a counter, a quote)
   * makes it contribute nothing.
   */
  const contentTextOf = (el: Element, value: string): string | null => {
    const tokens: string[] = [];
    const token = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-\w]+\((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*\)|\/|[-\w]+)/gy;
    let match: RegExpExecArray | null;
    let end = 0;
    while ((match = token.exec(value)) !== null) {
      tokens.push(match[1]!);
      end = token.lastIndex;
    }
    if (value.slice(end).trim() !== '') return null;
    let text = '';
    for (const part of tokens.slice(tokens.lastIndexOf('/') + 1)) {
      const attribute = /^attr\(\s*([-\w]+)\s*\)$/.exec(part);
      if (attribute !== null) text += el.getAttribute(attribute[1]!) ?? '';
      else if (part.startsWith('"') || part.startsWith("'")) {
        text += part.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_all, hex: string | undefined, char: string | undefined) =>
          hex === undefined ? char! : String.fromCodePoint(Number.parseInt(hex, 16)));
      } else return null;
    }
    return text;
  };

  /**
   * What an element's `::before` or `::after` adds to a name (accname 2F.ii):
   * its content's text, spaced like a block when the pseudo element is not
   * inline; empty when it shows nothing.
   */
  const generatedContentOf = (el: Element, pseudo: '::before' | '::after'): string => {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el, pseudo);
    if (style === undefined || style.display === 'none' || style.visibility === 'hidden') return '';
    const value = style.content;
    if (value === '' || value === 'none' || value === 'normal') return '';
    const text = contentTextOf(el, value);
    if (text === null) return '';
    return style.display === 'inline' ? text : ` ${text} `;
  };

  /** An element's `::before` contribution, once per read: nested named-from-content roles walk the same descendants again. */
  const beforeContentOf = memoized((el: Element) => generatedContentOf(el, '::before'));
  /** An element's `::after` contribution, once per read. */
  const afterContentOf = memoized((el: Element) => generatedContentOf(el, '::after'));

  /** True for a subtree the name computation drops: aria-hidden, or hidden by style as innerText leaves it out. */
  const isNameHidden = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true' ||
    (style !== undefined && (style.display === 'none' || style.visibility === 'hidden'));

  /** `alt` of an element HTML-AAM names by it: an `<img>` or an `<input type="image">`. */
  const altOf = (el: Element): string | null => {
    const named = el instanceof HTMLImageElement || (el instanceof HTMLInputElement && el.type === 'image');
    const alt = named ? el.getAttribute('alt') : null;
    return alt !== null && alt.trim() !== '' ? alt.trim() : null;
  };

  /**
   * The `<title>` child an SVG element is named by (SVG-AAM), as Playwright
   * reads it: `<svg><title>Close</title></svg>` is the image "Close". An svg
   * marked `presentation` or `none` takes no name of its own from it, though
   * the title still names a link or button around it.
   */
  const svgTitleOf = (el: Element): string | null => {
    if (!(el instanceof SVGElement)) return null;
    const title = Array.from(el.children).find((child) => child instanceof SVGTitleElement);
    const text = (title?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
  };

  /** True for an element whose role removes its semantics: `presentation` or `none`. */
  const isPresentational = (el: Element): boolean => {
    const role = implicitRole(el);
    return role === 'presentation' || role === 'none';
  };

  /**
   * True for a referenced target accname 2A reads whole: hidden itself, or
   * under an `aria-hidden` ancestor, which excludes it from the tree as
   * surely as its own attribute would.
   */
  const isReferenceHidden = (el: Element): boolean => isHidden(el) || el.closest('[aria-hidden="true" i]') !== null;

  /**
   * The element an id names for `el`, looked up in `el`'s own tree: an IDREF
   * resolves in the tree scope it is written in, so a shadow tree's ids are
   * its own and `getElementById` on the document never sees them. A root of
   * either kind answers for its tree once the reader holds the element.
   */
  const referencedElementOf = (el: Element, id: string): Element | null => {
    const root = el.getRootNode();
    return root instanceof Document || root instanceof DocumentFragment ? root.getElementById(id) : null;
  };

  /**
   * Each aria-labelledby target's contribution (accname 2B), in attribute
   * order, unnamed targets dropped; null when the targets' joined text is
   * empty, so the element names itself. The join is untrimmed, as Playwright
   * reads it: a target holding only whitespace, or two unnamed targets, end
   * the computation with no names. A hidden target is read whole, as a screen
   * reader reads it, and a reference inside a target is not followed, so this
   * is null inside a reference traversal too.
   */
  const referencedNamesOf = (el: Element, walk: NameWalk): string[] | null => {
    if (walk.inReference) return null;
    const ids = (el.getAttribute('aria-labelledby') ?? '').trim();
    if (ids === '') return null;
    const contributions: string[] = [];
    for (const id of ids.split(/\s+/)) {
      const target = referencedElementOf(el, id);
      if (target === null) continue;
      contributions.push(
        contentNameOf(target, styleOf(target), {
          inReference: true,
          hiddenAllowed: isReferenceHidden(target),
          visited: walk.visited,
          accessible: walk.accessible,
        }),
      );
    }
    if (contributions.join(' ') === '') return null;
    return contributions.map((text) => text.replace(/\s+/g, ' ').trim()).filter((name) => name !== '');
  };

  /**
   * What an embedded control contributes to a name computed through another
   * element (accname 2C), by the rules Playwright's role selector applies, so
   * `<button>Flash the screen <input value="3"> times</button>` is the button
   * "Flash the screen 3 times": a textbox or searchbox its current value (an
   * editable element its text), a combobox or listbox its selected options'
   * names (a native select with none selected its first option, a text field
   * with none its value), and a range widget its `aria-valuetext`, else its
   * `aria-valuenow`, else its `value` attribute. A menu contributes nothing,
   * and neither does a secure field, whose value no name may carry. Null for
   * any other element, and for one its own `aria-labelledby` names, which is
   * named, not embedded.
   */
  const embeddedControlNameOf = (el: Element, walk: NameWalk): string | null => {
    const role = implicitRole(el);
    if (role === null) return null;
    if (el.id !== '' && (el.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).indexOf(el.id) !== -1) return null;
    if (el.matches(options.secureFieldSelector)) return '';
    if (role === 'textbox' || role === 'searchbox') {
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? '';
    }
    if (role === 'combobox' || role === 'listbox') {
      let selected: Element[];
      if (el instanceof HTMLSelectElement) {
        selected = Array.from(el.selectedOptions);
        if (selected.length === 0 && el.options.length > 0) selected.push(el.options[0]!);
      } else {
        const listbox = role === 'combobox' ? ariaOwnedOf(el).find((owned) => implicitRole(owned) === 'listbox') : el;
        selected = listbox === undefined
          ? []
          : ariaOwnedOf(listbox).filter((owned) => owned.getAttribute('aria-selected') === 'true' && implicitRole(owned) === 'option');
      }
      if (selected.length === 0 && el instanceof HTMLInputElement) return el.value;
      return selected.map((option) => contentNameOf(option, styleOf(option), walk)).join(' ');
    }
    if (role === 'progressbar' || role === 'scrollbar' || role === 'slider' || role === 'spinbutton' || role === 'meter') {
      if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext') ?? '';
      if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow') ?? '';
      return el.getAttribute('value') ?? '';
    }
    return role === 'menu' ? '' : null;
  };

  /**
   * Every element under `el` and every element its `aria-owns` names, with
   * theirs: what a composite widget owns, as Playwright's role selector
   * collects a combobox's listbox and a listbox's options.
   */
  const ariaOwnedOf = (el: Element): Element[] => {
    const owned = Array.from(el.querySelectorAll('*'));
    for (const id of (el.getAttribute('aria-owns') ?? '').trim().split(/\s+/)) {
      const target = id === '' ? null : referencedElementOf(el, id);
      if (target !== null) owned.push(target, ...Array.from(target.querySelectorAll('*')));
    }
    return owned;
  };

  /**
   * What one element contributes to a name computed through another: as an
   * aria-labelledby target (accname 2B) or as a descendant read for name from
   * content (2F). Its own references, else its value as an embedded control,
   * its `aria-label`, its `alt`, its children, then its `title`. So
   * `<button><img alt="Search"></button>` is the button "Search", an icon
   * whose only child is
   * `<svg aria-labelledby="t"><title id="t">Close</title></svg>` is "Close",
   * and a hidden `<span>` a button references still names it. Any other form
   * control's content is its value, not label text, so it contributes nothing.
   * The title is the fallback only for empty content, untrimmed as Playwright
   * reads it: the spaces a block-level child adds count, so a flex container's
   * blockified icon keeps the container's `title` out of the name, the name
   * `getByRole` then fails to match.
   */
  const contentNameOf = (el: Element, style: CSSStyleDeclaration | undefined, walk: NameWalk): string => {
    if (walk.visited.has(el)) return '';
    walk.visited.add(el);
    if (!walk.hiddenAllowed && isNameHidden(el, style)) return '';
    const referenced = referencedNamesOf(el, walk);
    if (referenced !== null) return referenced.join(' ');
    const embedded = walk.accessible ? embeddedControlNameOf(el, walk) : null;
    if (embedded !== null) return embedded;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const alternative = altOf(el) ?? svgTitleOf(el);
    if (alternative !== null) return alternative;
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    const content = childrenNameOf(el, walk);
    if (content !== '') return content;
    const title = el.getAttribute('title');
    return title === null ? '' : title.trim();
  };

  /**
   * The children's contributions joined as Playwright's role selector joins
   * them: a space on each side of a block-level child and of a `<br>`, none
   * around an inline one. `<img alt="Search">Go` reads "SearchGo" and
   * `<div>A</div><div>B</div>` reads "A B", so the name a role query matched
   * is the name the node reports. An accessible name wraps them in the
   * element's generated content, so `<button class="next">Go</button>` with
   * `.next::after { content: " \2192" }` is the button "Go →".
   */
  const childrenNameOf = (el: Element, walk: NameWalk): string => {
    let out = walk.accessible ? beforeContentOf(el) : '';
    for (const child of contentChildrenOf(el)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? '';
        continue;
      }
      if (!(child instanceof Element)) continue;
      const style = styleOf(child);
      const token = contentNameOf(child, style, walk);
      const block = child.tagName === 'BR' || (style?.display ?? 'inline') !== 'inline';
      out += block ? ` ${token} ` : token;
    }
    return walk.accessible ? out + afterContentOf(el) : out;
  };

  /**
   * The nodes a name from content reads under an element, in the order the
   * page composes them: a `<slot>` reads what is assigned to it, and a host
   * reads its light children (a slotted one skipped, its slot reads it) and
   * then its shadow tree, so `<button>` whose text lives behind a shadow root
   * is named by that text as Playwright's role selector names it. Which light
   * children are slotted is read from the root's slots, not from each child's
   * `assignedSlot`: a closed root hides that property from the outside while
   * the tracked root's slots still list their assigned nodes.
   */
  const contentChildrenOf = (el: Element): ChildNode[] => {
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes();
      if (assigned.length > 0) return assigned as ChildNode[];
    }
    const shadow = shadowRootOf(el);
    if (shadow === null) return Array.from(el.childNodes);
    const slotted = new Set<Node>();
    for (const slot of Array.from(shadow.querySelectorAll('slot'))) {
      for (const node of slot.assignedNodes()) slotted.add(node);
    }
    const own = Array.from(el.childNodes).filter((child) => !slotted.has(child));
    return own.concat(Array.from(shadow.childNodes));
  };

  /**
   * Text for an accessible name from an element's own content (accname 2F):
   * its descendants' contributions, hidden and aria-hidden subtrees dropped (a
   * required-field marker, a decorative glyph), whitespace collapsed. The
   * element's own attributes are `accessibleName`'s business; this reads what
   * is inside it. `accessible` reads CSS generated content and embedded
   * controls' values too, as an accessible name does and label text does not.
   * `named` is the element the text names when that is not `el` (a control
   * read through its `<label>`), which never contributes to its own name.
   */
  const nameTextOf = (el: Element, accessible: boolean, named: Element = el): string => {
    if (isNameHidden(el, styleOf(el))) return '';
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    return childrenNameOf(el, nameWalk([el, named], accessible)).replace(/\s+/g, ' ').trim();
  };

  const NAME_OPAQUE_TAGS: ReadonlySet<string> = new Set(['TEXTAREA', 'SELECT', 'INPUT', 'SCRIPT', 'STYLE']);

  /**
   * Roles named from their content (accname 2F, the list Playwright's role
   * selector uses), plus `listitem`, `status`, and `alert`, which the tree
   * has always named so a list row or a message reads as one line.
   */
  const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
    'listitem',
    'status',
    'alert',
  ]);

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
    for (const name of referencedNamesOf(el, nameWalk([], false)) ?? []) labels.push(name);
    for (const label of associatedLabels(el)) {
      const text = nameTextOf(label, false);
      if (text !== '') labels.push(text);
    }
    const shown = labels.map(withoutGlyphs).filter((label) => label !== '');
    return shown.length === 0 ? null : shown;
  };

  /**
   * Text owned directly by an element, excluding descendant elements. An
   * element with `content-visibility: hidden` renders none of it, as its
   * `innerText` reads empty, so it owns none.
   */
  const directTextOf = memoized((el: Element): string => {
    if (styleOf(el)?.getPropertyValue('content-visibility') === 'hidden') return '';
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  });

  /**
   * Elements whose content is not text in a line: a form control's options
   * or value, a picture, a frame, a drawn surface. Like a line break, each
   * separates the words around it.
   */
  const LINE_BREAKING_TAGS = [...SKIP_TAGS, ...OPAQUE_TAGS, 'iframe', 'img', 'input', 'select', 'textarea', 'br'];

  /**
   * True when an element's text flows in its parent's line: a visible
   * inline-level box (`inline`, `inline-block`, `ruby`), or `display:
   * contents`, whose children lay out as the parent's own. Visible as the
   * walk reads it (`isHidden`): a box with no size shows no words. A slot
   * has no box and shows the nodes assigned to it, so only its visibility
   * counts: a hidden one hides the text they inherit it with, and a child
   * that shows itself again is listed on its own.
   */
  const flowsInLine = memoized((el: Element): boolean => {
    if (LINE_BREAKING_TAGS.indexOf(el.tagName.toLowerCase()) !== -1 || isEditingHost(el)) return false;
    const style = styleOf(el);
    if (style === undefined || hidesSubtree(el, style)) return false;
    if (el instanceof HTMLSlotElement ? style.visibility !== 'visible' : isHidden(el, style)) return false;
    return isInlineLevel(style);
  });

  /** True for a box laid out in its parent's line, or for `display: contents`, which lays out none of its own. */
  const isInlineLevel = (style: CSSStyleDeclaration): boolean =>
    style.display.startsWith('inline') || style.display.startsWith('ruby') || style.display === 'contents';

  /**
   * The nodes an element renders in its place, as the walk reaches them: a
   * shadow host's shadow tree (a closed one through the record), a slot's
   * assigned nodes or else its fallback content, any other element's children.
   */
  const renderedChildrenOf = (el: Element): Node[] => {
    const shadow = shadowRootOf(el);
    if (shadow !== null) return Array.from(shadow.childNodes);
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes();
      if (assigned.length > 0) return assigned;
    }
    return Array.from(el.childNodes);
  };

  /**
   * An element's rendered text with each inline descendant's text in place.
   * Anything else in the line reads as a space, except a hidden inline
   * element (a `<wbr>`, a zero-size span), which shows nothing.
   */
  const lineRunOf = (el: Element): string => {
    let out = '';
    for (const child of renderedChildrenOf(el)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
      if (child.nodeType !== 1) continue;
      const inner = child as Element;
      if (flowsInLine(inner)) {
        out += lineRunOf(inner);
        continue;
      }
      const style = styleOf(inner);
      if (style === undefined || hidesSubtree(inner, style)) continue;
      const breaking = LINE_BREAKING_TAGS.indexOf(inner.tagName.toLowerCase()) !== -1;
      if (breaking || !isInlineLevel(style) || !isHidden(inner, style)) out += ' ';
    }
    return out;
  };

  /**
   * The text an element owns, read as a person reads its line: its own text
   * with every inline descendant's text in place, so `<p>Read our <a>privacy
   * policy</a> for details.</p>` reads as the whole sentence while the link
   * stays a node of its own. Block-level descendants are nodes of their own
   * and only separate words. An element with no text of its own owns none: a
   * wrapper of elements leaves them to say what they say (`ownsLine`).
   */
  const lineTextOf = memoized((el: Element): string =>
    ownsLine(el) ? lineRunOf(el).replace(/\s+/g, ' ').trim() : '');

  /**
   * True when an element reads its own line: it has text of its own, or it
   * offers an action inside an ancestor's line, where its words are what a
   * person aims at.
   */
  const ownsLine = (el: Element): boolean => directTextOf(el) !== '' || (offersAction(el) && isReadInLine(el));

  /**
   * True when an element with no role still says it can be acted on: it is
   * focusable through `tabindex`, it has a click handler set as an attribute
   * or a property (`onclick`), or it is an `<a>` with no `href`, which an app
   * wires up by script. Such an element stays listed inside a line, so it
   * keeps an id to act on. A handler added with `addEventListener` leaves
   * nothing the page can read.
   */
  const offersAction = memoized((el: Element): boolean => {
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && /^\s*[-+]?\d/.test(tabindex)) return true;
    if (el.tagName.toLowerCase() === 'a' || el.hasAttribute('onclick')) return true;
    return el instanceof HTMLElement && el.onclick !== null;
  });

  /**
   * True when an element's text is already read in an ancestor's line
   * (`lineTextOf`), so the element has nothing to add on text alone. A line
   * longer than the projection's text bound is cut, so its inline
   * descendants stay listed and nothing past the cut is lost.
   */
  const isReadInLine = memoized((el: Element): boolean => {
    const parent = el.assignedSlot ?? parentOrHostOf(el);
    if (parent === null || !flowsInLine(el)) return false;
    if (!ownsLine(parent)) return isReadInLine(parent);
    const fits = projection.textLimit === null || lineTextOf(parent).length <= projection.textLimit;
    return fits && !isHidden(parent);
  });

  const accessibleName = memoized((el: Element): string | null => {
    // accname reads a labelledby reference (2B) before the element's own aria-label (2C).
    const referenced = referencedNamesOf(el, nameWalk([], true));
    if (referenced !== null) return referenced.join(' ');
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const labels = associatedLabels(el);
    if (labels.length > 0) {
      const joined = labels
        .map((label) => nameTextOf(label, true, el))
        .join(' ')
        .trim();
      if (joined !== '') return joined;
    }
    const alternative = altOf(el) ?? (isPresentational(el) ? null : svgTitleOf(el));
    if (alternative !== null) return alternative;
    const captionTag = NAMING_CHILD_TAGS[el.tagName.toLowerCase()];
    if (captionTag !== undefined) {
      const caption = Array.from(el.children).find((child) => child.tagName.toLowerCase() === captionTag);
      const text = caption === undefined ? '' : nameTextOf(caption, true);
      if (text !== '') return text;
    }
    if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
      if (el.value.trim() !== '') return el.value.trim();
      // HTML-AAM: a submit or reset button with no value reads its default label.
      if (el.type === 'submit') return 'Submit';
      if (el.type === 'reset') return 'Reset';
    }
    const role = implicitRole(el);
    if (role !== null && NAME_FROM_CONTENT_ROLES.has(role)) {
      const text = nameTextOf(el, true);
      if (text !== '') return text;
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
   * The element that holds focus, through every shadow root on the way.
   * `document.activeElement` is retargeted to the outermost host and each
   * root's `activeElement` names the next hop, so the chain is followed until
   * a root holds no focus of its own; a closed root is reached through the
   * record, as everywhere else in the reader.
   */
  const focusedElementOf = (doc: Document): Element | null => {
    let active = doc.activeElement;
    while (active !== null) {
      const next = shadowRootOf(active)?.activeElement ?? null;
      if (next === null) return active;
      active = next;
    }
    return null;
  };
  const focusedElement = focusedElementOf(element.ownerDocument);

  /**
   * The text selected inside a focused field: the slice between an input's or
   * textarea's selection ends, or the document selection when it lies within
   * an editing host. Null for a collapsed caret, so a node with no selection
   * reads exactly as before.
   */
  const selectedTextOf = (el: Element): string | null => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start === null || end === null || start === end) return null;
      return el.value.slice(Math.min(start, end), Math.max(start, end));
    }
    if (!isEditingHost(el)) return null;
    const selection = el.ownerDocument.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    if (!el.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
    const text = selection.toString();
    return text === '' ? null : text;
  };

  /** True for a text node that lays out to a box a person can see. */
  const isVisibleText = (node: Node): boolean => {
    const range = node.ownerDocument!.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /**
   * True for content a closed `<details>` folds away: anything under it that
   * is not in its `<summary>`. Every closed ancestor is asked, so a summary's
   * own controls stay visible while the closed body's do not, nested
   * `<details>` and their summaries included.
   */
  const isInClosedDetails = (el: Element): boolean => {
    let details = el.parentElement?.closest('details') ?? null;
    while (details !== null) {
      if (!details.open) {
        const summary = details.querySelector(':scope > summary');
        if (summary === null || !summary.contains(el)) return true;
      }
      details = details.parentElement?.closest('details') ?? null;
    }
    return false;
  };

  /**
   * True when an ancestor in the flat tree has `content-visibility: hidden`:
   * it keeps its own box and skips rendering everything under it, slotted
   * and shadow content included, as `checkVisibility()` reads it. Memoized,
   * so siblings under one ancestor share the walk up.
   */
  const isSkippedContent = memoized((el: Element): boolean => {
    const parent = el.assignedSlot ?? parentOrHostOf(el);
    if (parent === null) return false;
    return styleOf(parent)?.getPropertyValue('content-visibility') === 'hidden' || isSkippedContent(parent);
  });

  /**
   * Render visibility, the one Playwright's `toBeVisible` and `toBeHidden`
   * read, so a semantic `hidden` state and the platform's own filter agree:
   * `display: none` or a `visibility` other than `visible` on any element (an
   * SVG included), content a `content-visibility: hidden` ancestor skips or a
   * closed `<details>` folds away, and a box with no width or no height.
   * `aria-hidden` is not in it: it removes a node from the accessibility tree
   * (`hidesSubtree`, a role query) while the node still paints, as a spinner
   * marked decorative does. `display: contents` generates no box of its own
   * while every child still paints (Shopify's one-page checkout form is one),
   * so such an element is shown when some child element or text is, and
   * hidden when nothing under it is. Its text paints in its own `visibility`,
   * which a range's box does not reflect, so text under a hidden one is
   * hidden, where Playwright calls it visible.
   */
  const isHidden = (el: Element, style = styleOf(el)): boolean => {
    if (style === undefined) return true;
    if (isSkippedContent(el)) return true;
    if (style.display === 'contents') {
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        if (child instanceof Element && !isHidden(child)) return false;
        if (child.nodeType === Node.TEXT_NODE && style.visibility === 'visible' && isVisibleText(child)) return false;
      }
      return true;
    }
    if (style.display === 'none' || style.visibility !== 'visible') return true;
    if (isInClosedDetails(el)) return true;
    const rect = el.getBoundingClientRect();
    return !(rect.width > 0 && rect.height > 0);
  };

  /**
   * What takes the element and everything under it out of the tree walk: an
   * `aria-hidden` or inert subtree, which the accessibility tree drops though
   * it may paint (`isInert`), and `display: none` or a closed `<details>`
   * body, which no descendant can undo. A `visibility` other than `visible`
   * is not in it, since a descendant may set `visibility: visible` and paint
   * again; nor is a box with no size: a zero-height `<html>` or wrapper still
   * shows the fixed, absolute, and overflowing descendants laid out past its
   * edges. The walk goes on through both and only the element itself stays
   * unlisted.
   */
  const hidesSubtree = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true' ||
    isInert(el, style) ||
    style === undefined ||
    style.display === 'none' ||
    isInClosedDetails(el);

  /**
   * Inert content takes no input and is hidden from assistive technology, as
   * Chrome's tree drops it, though it still paints: listing it would hand the
   * agent controls that ignore every action. Chromium computes the inherited
   * `interactivity: inert`, which follows the flat tree, so a light child
   * slotted into an inert slot of a closed root counts; the attribute covers a
   * browser that does not compute it. A modal dialog's inertness of the rest
   * of the page is not in the style and stays listed.
   */
  const isInert = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    el.hasAttribute('inert') || style?.getPropertyValue('interactivity') === 'inert';

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
   * Reduces a link target to origin and path, dropping userinfo, query, and
   * fragment, which routinely carry tokens. A dropped query or fragment
   * leaves `?…` or `#…` behind, so the value never reads as the whole
   * target when it is not; a URL path never holds a literal `…`, since the
   * URL parser percent-encodes it. `mailto:` and `tel:` keep their scheme in
   * place of an origin; `blob:` keeps its inner URL, reduced the same way, or
   * becomes `blob:…` when that has no origin. Any other scheme with no
   * origin (`data:`, `javascript:`) carries its payload as its path, a whole
   * file or script, so it is reduced to `scheme:…`. The path is whole
   * otherwise: the harness bounds what it renders after redaction, and marks
   * what it cuts.
   */
  const originAndPath = (value: string, base: string): string => {
    const elided = (query: boolean, fragment: boolean): string => `${query ? '?…' : ''}${fragment ? '#…' : ''}`;
    try {
      const url = new URL(value, base);
      const rest = `${url.pathname}${elided(url.search !== '', url.hash !== '')}`;
      if (url.protocol === 'blob:') {
        const inner = URL.canParse(url.pathname) ? new URL(url.pathname) : null;
        return inner === null || inner.origin === 'null' ? 'blob:…' : `blob:${inner.origin}${inner.pathname}${elided(url.search !== '', url.hash !== '')}`;
      }
      if (url.origin !== 'null') return `${url.origin}${rest}`;
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') return `${url.protocol}${rest}`;
      return `${url.protocol}…`;
    } catch {
      const [beforeFragment = '', ...fragment] = value.split('#');
      const [path = '', ...query] = beforeFragment.split('?');
      return `${path}${elided(query.join('?') !== '', fragment.join('#') !== '')}`;
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

  /**
   * The roles WAI-ARIA 1.2 lets `aria-disabled` apply to, the same list
   * Playwright's `toBeDisabled` consults. Widgets and the composites that hold
   * them; a plain container or text takes no disabled state.
   */
  const ARIA_DISABLED_ROLES = [
    'application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem', 'scrollbar',
    'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox',
    'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem',
  ];

  /** The parent `aria-disabled` inherits across: the tree parent, or the host at a shadow root. */
  const parentOrHostOf = (el: Element): Element | null => {
    if (el.parentElement !== null) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  /**
   * What the nearest `aria-disabled` on the element or above it says
   * (WAI-ARIA: the state applies to every descendant), across shadow
   * boundaries, `false` cutting the chain. Memoized so a subtree under one
   * disabled ancestor costs one walk, not one per node.
   */
  const ariaDisabledInChain = memoized((el: Element): boolean => {
    const attribute = (el.getAttribute('aria-disabled') ?? '').toLowerCase();
    if (attribute === 'true') return true;
    if (attribute === 'false') return false;
    const parent = parentOrHostOf(el);
    return parent === null ? false : ariaDisabledInChain(parent);
  });

  /**
   * The disabled state a person meets, not the attribute the element carries.
   * `:disabled` is the browser's answer for a form control: its own attribute,
   * a disabled fieldset above it (except inside that fieldset's first legend),
   * a disabled optgroup. An `aria-disabled="true"` on the element counts for
   * any role; inherited from an ancestor, it reaches the roles the state
   * applies to, as Playwright reads it.
   */
  const isDisabled = (el: Element): boolean => {
    if (el.matches(':disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const role = implicitRole(el);
    return role !== null && ARIA_DISABLED_ROLES.indexOf(role) !== -1 && ariaDisabledInChain(el);
  };

  const describe = (el: Element, style = styleOf(el)): RawNodeData => {
    const tag = el.tagName.toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();

    let value: string | null = null;
    let checked: boolean | null = null;
    let selectedState: boolean | null = null;
    if (el instanceof HTMLInputElement) {
      // A checkbox or radio submits its value attribute (`on` by default)
      // whatever its checked state, so a locator read reports both; the tree
      // drops that token as it drops an option's.
      const checkable = el.type === 'checkbox' || el.type === 'radio';
      if (checkable) checked = el.checked;
      if (!checkable || projection.checkableValue) value = el.value;
    } else if (el instanceof HTMLTextAreaElement) {
      value = el.value;
    } else if (el instanceof HTMLSelectElement) {
      value = el.value;
    } else if (el instanceof HTMLOptionElement) {
      selectedState = el.selected;
      value = el.value;
    } else if (isEditingHost(el)) {
      // An editor's document is its value, as a textarea's text is: kept as
      // rendered, spaces and newlines included. An empty editor renders
      // `<p><br></p>`, which innerText reads as a newline, so a document with
      // no text nodes, or with only markup whitespace that renders as that one
      // newline, is an empty value; typed spaces are text nodes and stay. The
      // zero-width no-break space Slate and Quill pad an empty line with
      // renders nothing, so it is no text either. Cut like text in the
      // model-bound projection.
      const rendered = textOf(el).replace(/﻿/g, '');
      const text = (el.textContent ?? '').replace(/﻿/g, '');
      value = text === '' || (text.trim() === '' && rendered === '\n') ? '' : rendered;
      if (projection.textLimit !== null) value = value.slice(0, projection.textLimit);
    }
    // A native control's state is the control's, as Playwright reads it: a
    // stale aria-checked on a checkbox or aria-selected on an option says
    // nothing about what the browser will submit. ARIA fills in only where the
    // element has no native state.
    if (checked === null) {
      const ariaChecked = el.getAttribute('aria-checked');
      if (ariaChecked !== null) checked = ariaChecked === 'true';
    }
    if (selectedState === null) {
      const ariaSelected = el.getAttribute('aria-selected');
      if (ariaSelected !== null) selectedState = ariaSelected.toLowerCase() === 'true';
    }

    const disabled = isDisabled(el);

    const ariaExpanded = el.getAttribute('aria-expanded');
    const ariaPressed = el.getAttribute('aria-pressed');
    // Matched against the shared selector rather than re-derived from tag and
    // type, so this node's `secure` flag and the screenshot mask agree by
    // construction.
    const secure = el.matches(options.secureFieldSelector);
    let selection: string | null = null;
    if (focusedElement === el && !secure) {
      selection = selectedTextOf(el);
      if (selection !== null && projection.textLimit !== null) selection = selection.slice(0, projection.textLimit);
    }

    let inputPurpose: RawNodeData['inputPurpose'] = 'none';
    if (secure) inputPurpose = 'password';
    else if (autocomplete === 'username') inputPurpose = 'username';
    else if (autocomplete === 'current-password' || autocomplete === 'new-password') {
      inputPurpose = 'password';
    } else if (autocomplete === 'one-time-code') inputPurpose = 'one-time-code';

    const attributes: Record<string, string> = Object.create(null);
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
    else if (projection.lineText) text = lineTextOf(el);
    else text = textOf(el);
    if (projection.textLimit !== null) text = text.slice(0, projection.textLimit);

    let name = reportedName(el, accessibleName(el));
    if (projection.nameLimit !== null && name !== null) name = name.slice(0, projection.nameLimit);
    // A secure field withholds its value, never its labels: a password field is still found by its label.
    const labels = labelsOf(el);
    const isDocumentRoot = projection.documentRoot && tag === 'html';
    if (isDocumentRoot) name = el.ownerDocument.title;

    // No layout box at all (`display: none`, an empty `display: contents`) is
    // no rect, as Playwright's `boundingBox()` answers null; a box with no
    // size, or one `visibility: hidden` keeps, is still a rect.
    const rect = el.getClientRects().length === 0 ? null : el.getBoundingClientRect();
    const role = isDocumentRoot ? 'document' : roleOf(el, tag);
    let level: number | null = null;
    if (role === 'heading') {
      const ariaLevel = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
      if (Number.isInteger(ariaLevel) && ariaLevel > 0) level = ariaLevel;
      else if (/^h[1-6]$/.test(tag)) level = Number(tag.slice(1));
      // HTML-AAM: a role="heading" element with no aria-level is level 2.
      else level = 2;
    }

    return {
      role,
      name,
      labels,
      text,
      value: secure ? null : value,
      selection,
      inputPurpose,
      states: {
        checked,
        disabled,
        selected: selectedState,
        expanded: ariaExpanded === null ? null : ariaExpanded === 'true',
        pressed: ariaPressed === null ? null : ariaPressed === 'true',
        focused: focusedElement === el,
        hidden: isHidden(el, style),
        secure,
      },
      level,
      attributes,
      testId: el.getAttribute(options.testIdAttribute),
      rect: rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };

  // The conditional return type resolves per call site; inside the body the
  // discriminant narrows the value but not the generic, hence the casts.
  if (options.mode.kind === 'hidden') return isHidden(element) as SemanticResult<Mode>;
  if (options.mode.kind === 'node') {
    return describe(element) as SemanticResult<Mode>;
  }

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
    if (implicitRole(el) !== null && !isPresentational(el)) return true;
    if (accessibleName(el) !== null) return true;
    if (offersAction(el) && isReadInLine(el)) return lineTextOf(el) !== '';
    return directTextOf(el) !== '' && !isReadInLine(el);
  };

  const walk = (el: Element, parent: number): void => {
    if (truncated) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.indexOf(tag) !== -1) return;
    // Read once and share: `isHidden` and the empty-box test both need it, and
    // this walk already pays one `getComputedStyle` per node.
    const style = styleOf(el);
    if (hidesSubtree(el, style)) return;
    const hidden = isHidden(el, style);
    // The two elements listed by a rule of their own carry nothing a person
    // sees past their edges: a frame with no box shows none of its document,
    // and a select with none offers no options.
    if (hidden && (tag === 'iframe' || tag === 'select')) return;

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
    if (!hidden && (isInteresting(el) || isVisibleEmptyBox(el))) {
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
    // The element keeps its box, and nothing under it renders (`isSkippedContent`).
    if (style?.getPropertyValue('content-visibility') === 'hidden') return;
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

  // The root is the document the screen shows, listed whatever its own box: a
  // page of fixed controls leaves `<html>` with no height of its own.
  nodes[include(element, -1)]!.states.hidden = false;
  if (isInert(element, styleOf(element))) return { nodes, elements, ids, truncated } as SemanticResult<Mode>;
  for (const child of Array.from(element.children)) walk(child, 0);

  return { nodes, elements, ids, truncated } as SemanticResult<Mode>;
};
