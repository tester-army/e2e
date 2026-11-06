/**
 * The readers a document keeps: typed page functions over one shared
 * semantic reader, the contract's locator rules, and the builtins the
 * document had before its own scripts ran. `createReaders` builds them in
 * the page; a preload installs them per document, and a read sends only a
 * small call by name.
 */

import { createHash } from 'node:crypto';
import { createResolver, MATCHES_TEXT_SOURCE, type LocatorExpression, type matchesText as matchText, type SemanticQuery } from 'e2e/engine';
import { readSemanticsFunction } from './read-semantics.ts';
import type { RawNodeData, RawObservedNode, SemanticMode } from './read-node.ts';
import type { PageArgument, Wire } from '../driver/script.ts';

/** Where `BUILTINS_INIT_SCRIPT` keeps the builtins a page had before its own scripts ran. */
const BUILTINS_KEY = 'e2e.builtins';

/** The builtins the readers construct and call, as the document had them before any page script ran. */
const BUILTIN_NAMES = ['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON', 'Reflect', 'Symbol', 'Promise', 'Math', 'Number', 'String', 'RegExp', 'Error'] as const;

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

/**
 * A reader's metadata beside the elements it read: one JSON string when the
 * page left `JSON.stringify` native and added no `toJSON` the metadata would
 * go through, else the value itself.
 */
type Encoded<T> = readonly [metadata: T | string, elements: Element[]];

/** The walk's metadata, as the `tree` reader reports it. */
interface TreeMetadata {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly truncated: boolean;
}

/**
 * Builds the readers in the page over the shared semantic reader `read`,
 * the contract's locator rules `resolver`, and its text rule `matchesText`.
 * Serialized with `toString()`, so it closes over nothing of this module;
 * the builtins it names are the ones `READERS` binds around it, which the
 * document had before its own scripts ran.
 */
function createReaders(read: typeof readSemanticsFunction, resolver: typeof createResolver, matchesText: typeof matchText) {
  /** Whether `fn` reads as the native `JSON.stringify`; false when the page broke `Function.prototype.toString`, so it cannot tell. */
  const nativeStringify = (fn: unknown): boolean => {
    if (typeof fn !== 'function') return false;
    try {
      return /^function stringify\(\)\s*\{\s*\[native code\]\s*\}$/.test(Reflect.apply(Function.prototype.toString, fn, []) as string);
    } catch {
      return false;
    }
  };

  /** `data` as `Encoded` carries it: one JSON string when the page left `JSON.stringify` native and added no `toJSON` it would go through, else itself. */
  const encode = <T>(data: T): T | string =>
    nativeStringify(JSON.stringify) && !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype) ? JSON.stringify(data) : data;

  /** Whether `element` reads as hidden to the semantic reader, its `states.hidden`: for an iframe, whether everything inside it is hidden. */
  const hidden = (element: Element, options: ReadOptions): boolean => {
    return element.isConnected ? read(element, { ...options, mode: { kind: 'hidden' } }) : true;
  };

  /** Reads the document's semantic tree: the walk's metadata, and the walked elements. */
  const tree = (options: TreeOptions): Encoded<TreeMetadata> => {
    const observation = read(document.documentElement, options);
    return [encode({ nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated }), observation.elements];
  };

  /**
   * Resolves `expression` (as JSON) in the document by the contract's
   * locator rules, matching each element by Playwright's engines over the
   * reader's locator reads (`LocatorReads`): text queries and text filters
   * on the element's joined text, label queries on any of its labels, role
   * queries skipping what is hidden from the accessibility tree. Every
   * element through open and recorded closed shadow roots is a candidate, in
   * Playwright's match order: a root's light DOM before the content of its
   * shadow roots, each root in turn. `selected` holds the elements each
   * `selector` of the expression matches, read beforehand. In a hidden frame
   * every element is hidden. Answers the node read of each match, and the
   * matches; iframe documents are not entered.
   */
  const locate = (options: ReadOptions, expression: string, selected: [string, Element[]][], frameHidden: boolean, key: string): Encoded<RawNodeData[]> => {
    // A document a navigation just opened has no root yet: nothing in it can match.
    if (document.documentElement === null) return [encode([]), []];
    const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
    const nodes: Element[] = [];
    const parents = new Map<Element, Element>();
    const walkRoot = (children: Iterable<Element>, host: Element | undefined): void => {
      const shadows: [Element, ShadowRoot][] = [];
      const walk = (element: Element, parent: Element | undefined): void => {
        nodes.push(element);
        if (parent !== undefined) parents.set(element, parent);
        const shadow = element.shadowRoot ?? recorded?.get(element);
        if (shadow) shadows.push([element, shadow]);
        for (let child = element.firstElementChild; child !== null; child = child.nextElementSibling) walk(child, element);
      };
      for (const child of children) walk(child, host);
      for (const [shadowHost, shadow] of shadows) walkRoot(shadow.children, shadowHost);
    };
    walkRoot([document.documentElement], undefined);
    const reads = read(document.documentElement, { ...options, mode: { kind: 'locator' } });
    const selections = new Map(selected.map(([selector, elements]) => [selector, new Set(elements)]));
    const matches = (element: Element, query: SemanticQuery): boolean => {
      if (query.visible === true && (frameHidden || reads.hidden(element))) return false;
      switch (query.kind) {
        case 'role': {
          if (query.value.kind !== 'string' || frameHidden || !reads.hasRole(element, query.value.value)) return false;
          if (query.name !== undefined && !matchesText(reads.name(element) ?? '', query.name)) return false;
          if (reads.hiddenForAria(element)) return false;
          const wanted = query.states ?? {};
          if (wanted.checked !== undefined || wanted.pressed !== undefined || wanted.expanded !== undefined || wanted.selected !== undefined) {
            const states = reads.states(element, query.value.value);
            if (wanted.checked !== undefined && states.checked !== wanted.checked) return false;
            if (wanted.pressed !== undefined && states.pressed !== wanted.pressed) return false;
            if (wanted.expanded !== undefined && states.expanded !== wanted.expanded) return false;
            if (wanted.selected !== undefined && states.selected !== wanted.selected) return false;
          }
          if (wanted.disabled !== undefined && reads.disabled(element) !== wanted.disabled) return false;
          return query.level === undefined || reads.level(element) === query.level;
        }
        case 'text':
          return matchesText(reads.text(element), query.value);
        case 'label':
          return (reads.labels(element) ?? []).some((label) => matchesText(label, query.value));
        case 'displayValue': {
          const value = reads.displayValue(element);
          return value !== null && matchesText(value, query.value);
        }
        case 'placeholder': {
          const placeholder = element.getAttribute('placeholder');
          return placeholder !== null && matchesText(placeholder, query.value);
        }
        case 'testId': {
          const testId = element.getAttribute(options.testIdAttribute);
          return testId !== null && matchesText(testId, query.value);
        }
      }
    };
    // oxlint-disable-next-line e2e/no-unchecked-json -- the expression the driver serialized for this call
    const parsed = JSON.parse(expression) as LocatorExpression;
    const found = resolver<Element>({
      nodes,
      parent: (element) => parents.get(element),
      matches,
      hasText: (element, pattern) => matchesText(reads.text(element), pattern),
      selector: (selector, candidates) => {
        const hits = selections.get(selector);
        return hits === undefined ? [] : candidates.filter((element) => hits.has(element));
      },
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
    })(parsed);
    const described = found.map((element) => {
      const node = reads.describe(element);
      return frameHidden ? { ...node, states: { ...node.states, hidden: true } } : node;
    });
    return [encode(described), found];
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

/**
 * The readers over one shared semantic reader and the contract's locator
 * and text rules, all compiled where the builtins the document had before
 * its own scripts ran shadow the page's.
 */
const READERS = `(() => {
  const { ${BUILTIN_NAMES.join(', ')} } = globalThis[globalThis.Symbol.for(${JSON.stringify(BUILTINS_KEY)})] ?? globalThis;
  ${MATCHES_TEXT_SOURCE}
  return (${createReaders.toString()})((${readSemanticsFunction.toString()}), (${createResolver.toString()}), matchesText);
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
