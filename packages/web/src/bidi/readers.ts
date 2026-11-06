/**
 * The readers a document keeps: typed page functions over one shared
 * semantic reader and the builtins the document had before its own scripts
 * ran. `createReaders` builds them in the page; a preload installs them per
 * document, and a read sends only a small call by name.
 */

import { createHash } from 'node:crypto';
import type { QueryKind, TextPattern } from 'e2e/engine';
import { readSemanticsFunction } from '../in-page/read-semantics.ts';
import type { RawNodeData, RawObservedNode, SemanticMode } from '../read-node.ts';
import type { PageArgument, Wire } from './script.ts';

/** Where `BUILTINS_INIT_SCRIPT` keeps the builtins a page had before its own scripts ran. */
const BUILTINS_KEY = 'e2e.builtins';

/** The builtins the readers construct and call, as the document had them before any page script ran. */
const BUILTIN_NAMES = ['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON', 'Reflect', 'Symbol', 'Promise', 'Math', 'Number', 'String', 'RegExp', 'Error'] as const;

/** The builtins `BUILTINS_INIT_SCRIPT` keeps. */
type Builtins = Pick<typeof globalThis, (typeof BUILTIN_NAMES)[number]>;

/** Keeps each document's pristine builtins, before the page's scripts can delete or replace one. */
export const BUILTINS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(BUILTINS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  Object.defineProperty(globalThis, key, { value: Object.freeze({ ${BUILTIN_NAMES.join(', ')} }), enumerable: false, configurable: false, writable: false });
})();`;

/** What every reader passes the semantic reader beside its mode. */
type ReadOptions = { readonly testIdAttribute: string; readonly secureFieldSelector: string };

/** What the `tree` reader walks the document with. */
type TreeOptions = ReadOptions & { readonly mode: Extract<SemanticMode, { kind: 'tree' }> };

/** One query of a locate, as the `locate` reader narrows by it: a role query's role when it is a string. */
export type WantedQuery = { readonly kind: QueryKind; readonly value: TextPattern; readonly name?: TextPattern; readonly role?: string };

/** What a locate must read: each query of the expression, whether a text filter needs every element with text, and whether everything is read. */
export type LocateWants = { readonly queries: WantedQuery[]; readonly hasText: boolean; readonly all: boolean };

/**
 * A reader's metadata beside the elements it read: one JSON string when the
 * page left `JSON.stringify` native and added no `toJSON` the metadata would
 * go through, the value itself when asked `structured`, and null when it
 * must be asked so.
 */
export type Encoded<T> = readonly [metadata: T | string | null, elements: Element[]];

/** The walk's metadata, as the `tree` reader reports it. */
interface TreeMetadata {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly truncated: boolean;
}

/** What the `locate` reader reports beside the elements: each read, the index of its nearest read ancestor, and whether it displays its value (an input but a checkbox or radio, a textarea, a select). */
interface LocateMetadata {
  readonly nodes: RawNodeData[];
  readonly parents: number[];
  readonly valued: boolean[];
  readonly aria: PlaywrightAria[];
  /** Each element's place in Playwright's match order (a root's light DOM before its shadow roots). */
  readonly order: number[];
}

/**
 * What Playwright's own engines read of an element, beside the shared
 * reader: its text as the text engine joins it, whether the role engine
 * counts it hidden, and its ARIA states with `mixed` and absent kept apart
 * from false.
 */
export interface PlaywrightAria {
  readonly text: string;
  readonly hidden: boolean;
  readonly checked: boolean | 'mixed';
  readonly pressed: boolean | 'mixed';
  readonly expanded: boolean | null;
  readonly selected: boolean;
}

/**
 * Builds the readers in the page over the shared semantic reader `read`,
 * with `builtins` shadowing the page's own, so a page that deleted or
 * replaced `Map` (or another) cannot break a read. Serialized with
 * `toString()`, so it closes over nothing of this module.
 */
function createReaders(read: typeof readSemanticsFunction, builtins: Builtins) {
  const { Map, Set, Array, Object, JSON, Reflect, Symbol, String } = builtins;

  /** Whether the page left `JSON.stringify` native and added no `toJSON` the metadata would go through. */
  const nativeJson = (): boolean =>
    typeof JSON.stringify === 'function' &&
    /^function stringify\(\)\s*\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(JSON.stringify)) &&
    !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype);

  /** `data` as `Encoded` carries it: itself when asked `structured`, else one JSON string, or null when the page's JSON cannot be trusted. */
  const encode = <T>(data: T, structured: boolean): T | string | null => {
    if (structured) return data;
    return nativeJson() ? JSON.stringify(data) : null;
  };

  /**
   * Reads `PlaywrightAria` for each element, given the role the shared reader
   * gave it, by the rules of Playwright's injected script (`elementText`,
   * `isElementHiddenForAria`, `getAriaChecked`, `getAriaPressed`,
   * `getAriaExpanded`, `getAriaSelected`).
   */
  const playwrightAria = (elements: Element[], roles: (string | null)[]): PlaywrightAria[] => {
    const normalize = (text: string): string => text.replace(/​/g, '').trim().replace(/\s+/g, ' ');
    const texts = new Map<Element | ShadowRoot, string>();
    const textOf = (root: Element | ShadowRoot): string => {
      const cached = texts.get(root);
      if (cached !== undefined) return cached;
      let full = '';
      const skipped = root.nodeType === 1 && (['SCRIPT', 'NOSCRIPT', 'STYLE'].includes(root.nodeName) || (document.head !== null && document.head.contains(root)));
      if (!skipped) {
        if (root.nodeName === 'INPUT' && ['submit', 'button', 'reset'].includes((root as HTMLInputElement).type)) {
          full = (root as HTMLInputElement).value;
        } else {
          for (let child = root.firstChild; child !== null; child = child.nextSibling) {
            if (child.nodeType === 3) full += child.nodeValue ?? '';
            else if (child.nodeType === 1) full += textOf(child as Element);
          }
          if (root.nodeType === 1 && (root as Element).shadowRoot !== null) full += textOf((root as Element).shadowRoot!);
        }
      }
      texts.set(root, full);
      return full;
    };
    const parentOrHost = (element: Element): Element | null =>
      element.parentElement ?? (element.parentNode?.nodeType === 11 ? (element.parentNode as ShadowRoot).host : null);
    const hiddenUp = new Map<Element, boolean>();
    const belongsHidden = (element: Element): boolean => {
      let hidden = hiddenUp.get(element);
      if (hidden === undefined) {
        hidden = element.parentElement !== null && element.parentElement.shadowRoot !== null && element.assignedSlot === null;
        if (!hidden) hidden = getComputedStyle(element).display === 'none' || (element.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true';
        if (!hidden) {
          const parent = parentOrHost(element);
          if (parent !== null) hidden = belongsHidden(parent);
        }
        hiddenUp.set(element, hidden);
      }
      return hidden;
    };
    const styleVisible = (element: Element, style: CSSStyleDeclaration): boolean =>
      (typeof element.checkVisibility !== 'function' || element.checkVisibility()) && style.visibility === 'visible';
    const hiddenForAria = (element: Element): boolean => {
      if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].includes(element.nodeName)) return true;
      const style = getComputedStyle(element);
      const slot = element.nodeName === 'SLOT';
      if (style.display === 'contents' && !slot) {
        for (let child = element.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType === 1 && !hiddenForAria(child as Element)) return false;
          if (child.nodeType === 3 && (child.nodeValue ?? '').trim() !== '') return false;
        }
        return true;
      }
      const option = element.nodeName === 'OPTION' && element.closest('select') !== null;
      if (!option && !slot && !styleVisible(element, style)) return true;
      return belongsHidden(element);
    };
    const checkedRoles = new Set(['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem']);
    const pressedRoles = new Set(['button']);
    const expandedRoles = new Set(['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'row', 'rowheader', 'tab', 'treeitem', 'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch']);
    const selectedRoles = new Set(['gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem']);
    return elements.map((element, index) => {
      const role = roles[index] ?? '';
      let checked: boolean | 'mixed' = false;
      const input = element.nodeName === 'INPUT' ? (element as HTMLInputElement) : null;
      if (input !== null && input.indeterminate) checked = 'mixed';
      else if (input !== null && ['checkbox', 'radio'].includes(input.type)) checked = input.checked;
      else if (checkedRoles.has(role)) checked = element.getAttribute('aria-checked') === 'true' ? true : element.getAttribute('aria-checked') === 'mixed' ? 'mixed' : false;
      const pressedAttribute = element.getAttribute('aria-pressed');
      const pressed: boolean | 'mixed' = pressedRoles.has(role) ? (pressedAttribute === 'true' ? true : pressedAttribute === 'mixed' ? 'mixed' : false) : false;
      let expanded: boolean | null = null;
      if (element.nodeName === 'DETAILS') expanded = (element as HTMLDetailsElement).open;
      else if (expandedRoles.has(role) && element.getAttribute('aria-expanded') !== null) expanded = element.getAttribute('aria-expanded') === 'true';
      const selected = element.nodeName === 'OPTION' ? (element as HTMLOptionElement).selected : selectedRoles.has(role) && element.getAttribute('aria-selected') === 'true';
      return { text: normalize(textOf(element)), hidden: hiddenForAria(element), checked, pressed, expanded, selected };
    });
  };

  /** Whether `element` reads as hidden to the semantic reader, its `states.hidden`: for an iframe, whether everything inside it is hidden. */
  const hidden = (element: Element, options: ReadOptions): boolean => {
    return element.isConnected ? read(element, { ...options, mode: { kind: 'hidden' } }) : true;
  };

  /** Reads the document's semantic tree: the walk's metadata, and the walked elements. */
  const tree = (options: TreeOptions, structured: boolean): Encoded<TreeMetadata> => {
    const observation = read(document.documentElement, options);
    const data = { nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated };
    return [encode(data, structured), observation.elements];
  };

  /**
   * Reads the elements a locate could match, in document order through open
   * and recorded closed shadow roots, with the reader's node projection (the
   * full locator-read surface), all under one reader. `wants` lists the
   * expression's queries: an element is read when some query could match it,
   * a superset test on what that query compares (its role, then its name; an
   * attribute; its text), case-insensitive with whitespace removed, so the
   * contract's resolver, which runs on the reads, stays the one judge. A
   * pattern is no prefilter. A shadow host is always read, since its text is
   * in its shadow tree. Skipped elements leave their read descendants under
   * the nearest read ancestor, which keeps every containment a scope or
   * filter asks about. Iframe documents are not entered.
   */
  const locate = (options: ReadOptions, wants: LocateWants, key: string, structured: boolean): Encoded<LocateMetadata> => {
    // A document a navigation just opened has no root yet: nothing in it can match.
    if (document.documentElement === null) {
      const none: LocateMetadata = { nodes: [], parents: [], valued: [], aria: [], order: [] };
      return [encode(none, structured), []];
    }
    const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
    const labelable = 'input, select, textarea, button, meter, output, progress, [aria-label], [aria-labelledby], [contenteditable], [role]';
    const squash = (text: string): string => text.replace(/\s+/g, '').toLowerCase();
    const may = (actual: unknown, pattern: TextPattern | undefined | null): boolean =>
      pattern === undefined || pattern === null || pattern.kind !== 'string' || (actual !== null && actual !== undefined && squash(String(actual)).includes(squash(pattern.value)));
    const all: Element[] = [];
    const parentOf: number[] = [];
    const hosts = new Set<number>();
    const visit = (element: Element, parent: number): void => {
      const index = all.length;
      all.push(element);
      parentOf.push(parent);
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) {
        hosts.add(index);
        for (const child of shadow.children) visit(child, index);
      }
      for (const child of element.children) visit(child, index);
    };
    visit(document.documentElement, -1);
    const base = { testIdAttribute: options.testIdAttribute, secureFieldSelector: options.secureFieldSelector };
    const keep = all.map(() => wants.all);
    if (!wants.all) {
      const roleQueries = wants.queries.filter((query) => query.kind === 'role');
      if (roleQueries.length > 0) {
        const roles = read(document.documentElement, { ...base, mode: { kind: 'roles', elements: all } });
        const named: number[] = [];
        all.forEach((_element, index) => {
          for (const query of roleQueries) {
            if (roles[index] !== query.role) continue;
            if (query.name === undefined || query.name.kind !== 'string') keep[index] = true;
            else named.push(index);
            return;
          }
        });
        const names = named.length === 0 ? [] : read(document.documentElement, { ...base, mode: { kind: 'names', elements: named.map((index) => all[index]!) } });
        named.forEach((index, at) => {
          const name = names[at];
          // A nameless element may still match by a label the resolver reads; only a known name can rule it out.
          if (roleQueries.some((query) => query.role === roles[index] && (name === null || may(name, query.name)))) keep[index] = true;
        });
      }
      all.forEach((element, index) => {
        if (keep[index]) return;
        if (wants.hasText && (element.textContent!.trim() !== '' || hosts.has(index))) {
          keep[index] = true;
          return;
        }
        for (const query of wants.queries) {
          switch (query.kind) {
            case 'testId': {
              const value = element.getAttribute(options.testIdAttribute);
              if (value !== null && may(value, query.value)) keep[index] = true;
              break;
            }
            case 'placeholder': {
              const value = element.getAttribute('placeholder');
              if (value !== null && may(value, query.value)) keep[index] = true;
              break;
            }
            case 'displayValue':
              if (element.localName === 'select' || (/^(input|textarea)$/.test(element.localName) && may((element as HTMLInputElement).value, query.value))) keep[index] = true;
              break;
            case 'label':
              if (element.matches(labelable)) keep[index] = true;
              break;
            case 'text':
              if (hosts.has(index) || element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') || element.hasAttribute('alt') ||
                  element.hasAttribute('title') || element.hasAttribute('value') || may(element.textContent, query.value)) keep[index] = true;
              break;
          }
          if (keep[index]) return;
        }
      });
    }
    const nearest = all.map(() => -1);
    const elements: Element[] = [];
    const parents: number[] = [];
    all.forEach((element, index) => {
      const above = parentOf[index]! >= 0 ? nearest[parentOf[index]!]! : -1;
      if (keep[index]) {
        nearest[index] = elements.length;
        parents.push(above);
        elements.push(element);
      } else {
        nearest[index] = above;
      }
    });
    const nodes = read(document.documentElement, { ...base, mode: { kind: 'nodes', elements } });
    // Playwright's engines list a root's light-DOM elements before the content of its shadow roots, each root in turn.
    const rank = new Map<Element, number>();
    const rankRoot = (children: Iterable<Element>): void => {
      const shadows: ShadowRoot[] = [];
      const walk = (element: Element): void => {
        rank.set(element, rank.size);
        const shadow = element.shadowRoot ?? recorded?.get(element);
        if (shadow) shadows.push(shadow);
        for (const child of element.children) walk(child);
      };
      for (const child of children) walk(child);
      for (const shadow of shadows) rankRoot(shadow.children);
    };
    rankRoot([document.documentElement]);
    const order = elements.map((element) => rank.get(element) ?? 0);
    const valued = elements.map((element) => element.matches('input:not([type="checkbox" i]):not([type="radio" i]), textarea, select'));
    const aria = playwrightAria(elements, nodes.map((node) => node.role));
    return [encode({ nodes, parents, valued, aria, order }, structured), elements];
  };

  /**
   * Whether an element is disabled as the shared reader decides it (its
   * `:disabled` state, and `aria-disabled` on it or inherited by its role),
   * so an action refuses exactly what an observation reports disabled. The
   * element is first retargeted as Playwright's enabled check does: to the
   * button, checkbox, or radio that holds it, or the control its label names.
   * Null for a detached element, which a locate must find again.
   */
  const disabled = (target: Element, options: ReadOptions): boolean | null => {
    if (!target.isConnected) return null;
    let element = target;
    if (!element.matches('input, textarea, select') && !(element as HTMLElement).isContentEditable) {
      element = element.closest('button, [role=button], [role=checkbox], [role=radio]') ?? element;
      if (!element.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]')) {
        const control = element.closest('label')?.control;
        if (control) element = control;
      }
    }
    const [node] = read(document.documentElement, { ...options, mode: { kind: 'nodes', elements: [element] } });
    return node === undefined ? false : node.states.disabled === true;
  };

  return Object.freeze({ hidden, tree, locate, disabled });
}

/** The readers a document keeps, by name. */
type Readers = ReturnType<typeof createReaders>;

/** The name of a reader a document keeps (`readerCall`). */
export type ReaderName = keyof Readers;

/** What reader `K` takes, as it crosses the wire. */
export type ReaderArgs<K extends ReaderName> = Wire<Parameters<Readers[K]>> & readonly PageArgument[];

/** What reader `K` answers, as it crosses the wire. */
export type ReaderResult<K extends ReaderName> = Wire<ReturnType<Readers[K]>>;

/** The readers that answer `Encoded` metadata, asked `structured` by their last argument. */
export type EncodedReaderName = { [K in ReaderName]: ReturnType<Readers[K]> extends Encoded<unknown> ? K : never }[ReaderName];

/** What encoded reader `K` takes but its `structured` flag, as it crosses the wire. */
export type EncodedReaderArgs<K extends EncodedReaderName> = Parameters<Readers[K]> extends [...infer Rest, boolean] ? Wire<Rest> & readonly PageArgument[] : never;

/** The decoded metadata of encoded reader `K`, as it crosses the wire. */
export type ReaderMetadata<K extends EncodedReaderName> = ReturnType<Readers[K]> extends Encoded<infer T> ? Wire<T> : never;

/** The readers over one shared semantic reader, both compiled where the builtins the document had before its own scripts ran shadow the page's. */
const READERS = `(() => {
  const { ${BUILTIN_NAMES.join(', ')} } = globalThis[globalThis.Symbol.for(${JSON.stringify(BUILTINS_KEY)})] ?? globalThis;
  return (${createReaders.toString()})((${readSemanticsFunction.toString()}), { ${BUILTIN_NAMES.join(', ')} });
})()`;

/** Where a document keeps its readers: named by their source, so another driver version attached to the same browser keeps its own. */
const READERS_KEY = `e2e.readers.${createHash('sha256').update(READERS).digest('hex').slice(0, 16)}`;

/** Defines the document's readers once, out of reach of the page's own assignments. */
const DEFINE_READERS = `const key = globalThis.Symbol.for(${JSON.stringify(READERS_KEY)});
  if (!Object.prototype.hasOwnProperty.call(globalThis, key)) {
    Object.defineProperty(globalThis, key, { value: ${READERS}, enumerable: false, configurable: false, writable: false });
  }`;

/**
 * Installs the readers in every document before its scripts run, so a read
 * sends only `readerCall`: the readers are about 90 KB of source, and a
 * call that sends them is compiled again every time, which costs a read
 * about 2 ms against a fraction of one.
 */
export const READERS_INIT_SCRIPT = `(() => {
  ${DEFINE_READERS}
})();`;

/** What `readerCall` answers in a document the preload never ran in (one open before it, or an extension page). */
export const READERS_MISSING = 'e2e:readers-missing';

/** Calls the reader `name` that the document keeps, or answers `READERS_MISSING` when it keeps none. */
export function readerCall(name: ReaderName): string {
  return `(...args) => {
  const readers = globalThis[globalThis.Symbol.for(${JSON.stringify(READERS_KEY)})];
  return readers === undefined ? ${JSON.stringify(READERS_MISSING)} : readers.${name}(...args);
}`;
}

/** Calls the reader `name` in a document that keeps none, defining the readers there first; one that cannot keep them (a frozen global) is still read. */
export function readerInstallCall(name: ReaderName): string {
  return `(...args) => {
  try {
    ${DEFINE_READERS}
  } catch {}
  return (globalThis[globalThis.Symbol.for(${JSON.stringify(READERS_KEY)})] ?? ${READERS}).${name}(...args);
}`;
}
