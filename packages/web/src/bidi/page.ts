/**
 * Page functions the BiDi surface calls with `script.callFunction`. Each is a
 * self-contained function serialized with `toString()`, so none closes over
 * module scope; the tree reader is embedded from its own source.
 */

import { readSemanticsFunction } from '../in-page/read-semantics.ts';
import type { RawNodeData, RawObservedNode } from '../read-node.ts';

/** Where `BUILTINS_INIT_SCRIPT` keeps the builtins a page had before its own scripts ran. */
const BUILTINS_KEY = 'e2e.builtins';

/** The builtins the readers construct and call, as the document had them before any page script ran. */
const BUILTIN_NAMES = ['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON', 'Reflect', 'Symbol', 'Promise', 'Math', 'Number', 'String', 'RegExp', 'Error'];

/** Keeps each document's pristine builtins, before the page's scripts can delete or replace one. */
export const BUILTINS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(BUILTINS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  Object.defineProperty(globalThis, key, { value: Object.freeze({ ${BUILTIN_NAMES.join(', ')} }), enumerable: false, configurable: false, writable: false });
})();`;

/**
 * Declarations that shadow the builtins inside a page function with the
 * pristine ones `BUILTINS_INIT_SCRIPT` kept, so a page that deleted or
 * replaced `Map` (or another) cannot break a read; the page's own when the
 * document never ran the preload.
 */
const PRISTINE = `const { ${BUILTIN_NAMES.join(', ')} } = globalThis[globalThis.Symbol.for(${JSON.stringify(BUILTINS_KEY)})] ?? globalThis;`;

/**
 * Whether the page left `JSON.stringify` native and added no `toJSON` a
 * read's metadata would go through, so the metadata can cross as one string;
 * else it crosses as a structured value.
 */
const NATIVE_JSON = `typeof JSON.stringify === 'function' &&
    /^function stringify\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$/.test(Function.prototype.toString.call(JSON.stringify)) &&
    !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype)`;

/** Whether `element` reads as hidden to the semantic reader, its `states.hidden`: for an iframe, whether everything inside it is hidden. */
export const ELEMENT_HIDDEN = `(element, options) => {
  ${PRISTINE}
  const read = (${readSemanticsFunction.toString()});
  return element.isConnected ? read(element, { ...options, mode: { kind: 'hidden' } }) : true;
}`;

/** Reads the document's semantic tree: the walk's metadata (see `NATIVE_JSON`), and the walked elements. */
export const READ_TREE = `(options, structured) => {
  ${PRISTINE}
  const read = (${readSemanticsFunction.toString()});
  const observation = read(document.documentElement, options);
  const data = { nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated };
  if (structured) return [data, observation.elements];
  return [${NATIVE_JSON} ? JSON.stringify(data) : null, observation.elements];
}`;

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
export const LOCATE_READ = `(options, wants, key, structured) => {
  ${PRISTINE}
  const read = (${readSemanticsFunction.toString()});
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  const labelable = 'input, select, textarea, button, meter, output, progress, [aria-label], [aria-labelledby], [contenteditable], [role]';
  const squash = (text) => text.replace(/\\s+/g, '').toLowerCase();
  const may = (actual, pattern) => pattern === undefined || pattern === null || pattern.kind !== 'string' || (actual !== null && actual !== undefined && squash(String(actual)).includes(squash(pattern.value)));
  const all = [];
  const parentOf = [];
  const hosts = new Set();
  const visit = (element, parent) => {
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
      const named = [];
      all.forEach((element, index) => {
        for (const query of roleQueries) {
          if (roles[index] !== query.role) continue;
          if (query.name === undefined || query.name.kind !== 'string') keep[index] = true;
          else named.push(index);
          return;
        }
      });
      const names = named.length === 0 ? [] : read(document.documentElement, { ...base, mode: { kind: 'names', elements: named.map((index) => all[index]) } });
      named.forEach((index, at) => {
        const name = names[at];
        // A nameless element may still match by a label the resolver reads; only a known name can rule it out.
        if (roleQueries.some((query) => query.role === roles[index] && (name === null || may(name, query.name)))) keep[index] = true;
      });
    }
    all.forEach((element, index) => {
      if (keep[index]) return;
      if (wants.hasText && (element.textContent.trim() !== '' || hosts.has(index))) {
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
            if (element.localName === 'select' || (/^(input|textarea)$/.test(element.localName) && may(element.value, query.value))) keep[index] = true;
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
  const nearest = new Array(all.length).fill(-1);
  const elements = [];
  const parents = [];
  all.forEach((element, index) => {
    const above = parentOf[index] >= 0 ? nearest[parentOf[index]] : -1;
    if (keep[index]) {
      nearest[index] = elements.length;
      parents.push(above);
      elements.push(element);
    } else {
      nearest[index] = above;
    }
  });
  const nodes = read(document.documentElement, { ...base, mode: { kind: 'nodes', elements } });
  const valued = elements.map((element) => element.matches('input:not([type="checkbox" i]):not([type="radio" i]), textarea, select'));
  const aria = (${playwrightAria.toString()})(elements, nodes.map((node) => node.role));
  if (structured) return [{ nodes, parents, valued, aria }, elements];
  return [${NATIVE_JSON} ? JSON.stringify({ nodes, parents, valued, aria }) : null, elements];
}`;


/**
 * Whether an element is disabled as the shared reader decides it (its
 * `:disabled` state, and `aria-disabled` on it or inherited by its role),
 * so an action refuses exactly what an observation reports disabled. The
 * element is first retargeted as Playwright's enabled check does: to the
 * button, checkbox, or radio that holds it, or the control its label names.
 * Null for a detached element, which a locate must find again.
 */
export const ELEMENT_DISABLED = `(target, options) => {
  if (!target.isConnected) return null;
  let element = target;
  if (!element.matches('input, textarea, select') && !element.isContentEditable) {
    element = element.closest('button, [role=button], [role=checkbox], [role=radio]') ?? element;
    if (!element.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]')) {
      const control = element.closest('label')?.control;
      if (control) element = control;
    }
  }
  ${PRISTINE}
  const read = (${readSemanticsFunction.toString()});
  const [node] = read(document.documentElement, { ...options, mode: { kind: 'nodes', elements: [element] } });
  return node === undefined ? false : node.states.disabled === true;
}`;

/** What `LOCATE_READ` reports beside the elements: each read, the index of its nearest read ancestor, and whether it displays its value (an input but a checkbox or radio, a textarea, a select). */
export interface LocateMetadata {
  readonly nodes: RawNodeData[];
  readonly parents: number[];
  readonly valued: boolean[];
  readonly aria: PlaywrightAria[];
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
 * Reads `PlaywrightAria` for each element, given the role the shared reader
 * gave it, by the rules of Playwright's injected script (`elementText`,
 * `isElementHiddenForAria`, `getAriaChecked`, `getAriaPressed`,
 * `getAriaExpanded`, `getAriaSelected`). Runs in the page, embedded in
 * `LOCATE_READ`.
 */
function playwrightAria(elements: Element[], roles: (string | null)[]): PlaywrightAria[] {
  const normalize = (text: string): string => text.replace(/\u200b/g, '').trim().replace(/\s+/g, ' ');
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
}

/** The walk's metadata, as `READ_TREE` reports it. */
export interface TreeMetadata {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly truncated: boolean;
}

/** Where an action can land on an element, or why it cannot yet. */
export type ActionPoint =
  | { readonly state: 'ok'; readonly x: number; readonly y: number }
  | { readonly state: 'detached' | 'hidden' | 'disabled' | 'moving' | 'outside' };

/** What `actionPoint` checks: `scroll` to bring the element into view first; `key` names the closed-roots registry. */
export interface ActionPointOptions {
  readonly scroll: boolean;
  /** False for an action that types or selects rather than points: then only visibility counts, not stability or a point in view. */
  readonly pointer?: boolean;
  /** How to scroll the element into view, for a retry after an overlay covered it; unset, only when its point is clipped. */
  readonly align?: { readonly block: ScrollLogicalPosition; readonly inline: ScrollLogicalPosition };
  readonly key: string;
}

/**
 * The checks Playwright runs before a pointer action, but the hit test and
 * the enabled check (`ELEMENT_DISABLED`): attached, visible, scrolled into view when its point is clipped by the
 * viewport or a scrolling ancestor (or as `align` says), and holding still
 * for a frame. The point is the centre of the element's first client rect
 * that shows at least a pixel, as Playwright's clickable point, in whole
 * pixels inside that rect: pointer input takes whole pixels, and a
 * rounded centre can miss a small element.
 */
export async function actionPoint(element: Element, options: ActionPointOptions): Promise<ActionPoint> {
  if (!element.isConnected) return { state: 'detached' };
  const style = getComputedStyle(element);
  const rectsOf = (): DOMRect[] => {
    const own = [...element.getClientRects()];
    if (own.length > 0 || style.display !== 'contents') return own;
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()];
  };
  const box = rectsOf()[0] ?? element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') return { state: 'hidden' };
  if (options.pointer === false) return { state: 'ok', x: 0, y: 0 };
  type Area = { left: number; top: number; right: number; bottom: number };
  const viewport = (): { width: number; height: number } => ({
    width: visualViewport?.width || innerWidth,
    height: visualViewport?.height || innerHeight,
  });
  const clipped = (rect: DOMRect): Area | null => {
    const { width, height } = viewport();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, width);
    let bottom = Math.min(rect.bottom, height);
    let at: Element | null = element;
    let position = getComputedStyle(element).position;
    while (at !== null) {
      const parent: Node | null = at.parentNode;
      at = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
      if (at === null || at === document.documentElement) break;
      const clip = getComputedStyle(at);
      const transformed = clip.transform !== 'none' || clip.filter !== 'none' || clip.perspective !== 'none' || clip.contain.includes('paint') || clip.contain.includes('layout');
      if (position === 'fixed' && !transformed) continue;
      if (position === 'absolute' && !transformed && clip.position === 'static') continue;
      position = clip.position;
      const bounds = at.getBoundingClientRect();
      if (clip.overflowX !== 'visible') {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (clip.overflowY !== 'visible') {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return (right - left) * (bottom - top) > 0.99 && right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  const visible = (): Area | null => {
    for (const rect of rectsOf()) {
      const area = clipped(rect);
      if (area !== null) return area;
    }
    return null;
  };
  const centred = (area: Area | null): boolean => {
    const rect = rectsOf()[0] ?? element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return area !== null && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
  };
  const scrolled = element.getClientRects().length > 0
    ? element
    : ([...element.querySelectorAll('*')].find((child) => child.getClientRects().length > 0) ?? element.parentElement ?? element);
  if (options.scroll && options.align !== undefined) scrolled.scrollIntoView({ ...options.align, behavior: 'instant' });
  else if (options.scroll && !centred(visible())) scrolled.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  // Read in two frames whose animation time differs: a frame that repeats the time shows no motion.
  const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const first = await frame();
  const before = rectsOf()[0] ?? element.getBoundingClientRect();
  for (let tries = 0; tries < 5 && (await frame()) === first; tries += 1);
  const after = rectsOf()[0] ?? element.getBoundingClientRect();
  if (after.x !== before.x || after.y !== before.y || after.width !== before.width || after.height !== before.height) return { state: 'moving' };
  const area = visible();
  if (area === null) return { state: 'outside' };
  const x = (area.left + area.right) / 2;
  const y = (area.top + area.bottom) / 2;
  const inside = (px: number, py: number): boolean => px >= area.left && px < area.right && py >= area.top && py < area.bottom;
  for (const [px, py] of [[Math.floor(x), Math.floor(y)], [Math.floor(x) + 1, Math.floor(y)], [Math.floor(x) + 1, Math.floor(y) + 1], [Math.floor(x), Math.floor(y) + 1]] as const) {
    if (inside(px, py)) return { state: 'ok', x: px, y: py };
  }
  return { state: 'ok', x: Math.round(x), y: Math.round(y) };
}

/**
 * Why a pointer event at `x`, `y` of the element's document would not reach
 * the element, descending through open and recorded closed shadow roots to
 * the element actually hit; null when it would. As Playwright's hit check,
 * the element is first retargeted to the button or link that holds it (a
 * label inside a button lets the button take the event), and the hit
 * element's ancestors are walked through the slots it is assigned to.
 */
export function hitBlocker(element: Element, x: number, y: number, key: string): string | null {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  const target = element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable
    ? element
    : (element.closest('button, [role=button], a, [role=link]') ?? element);
  let hit = document.elementFromPoint(x, y);
  for (let root = hit?.shadowRoot ?? recorded?.get(hit!); hit !== null && root !== undefined && root !== null; root = hit.shadowRoot ?? recorded?.get(hit)) {
    const inner = root.elementFromPoint(x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null) return 'no element receives pointer events at the action point';
  for (let at: Element | null = hit; at !== null; at = at.assignedSlot ?? at.parentElement ?? (at.parentNode instanceof ShadowRoot ? at.parentNode.host : null)) {
    if (at === target) return null;
  }
  return `<${hit.localName}${hit.id === '' ? '' : `#${hit.id}`}> intercepts pointer events`;
}

/** The viewport's size in CSS pixels. */
export function viewportSize(): { width: number; height: number } {
  return { width: innerWidth, height: innerHeight };
}

/** Resolves once the document is past `loading`, or after `timeoutMs`. */
export function domReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    document.addEventListener('DOMContentLoaded', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

/** Resolves after the next rendered frame, or at once in a hidden document. */
export function nextFrame(): Promise<void> | undefined {
  if (document.visibilityState === 'hidden') return undefined;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Focuses an element; returns whether focus landed on it, or on the editing
 * host that holds it, followed through open and recorded closed shadow roots.
 */
export function focus(element: Element, key: string): boolean {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  (element as HTMLElement).focus();
  let active = document.activeElement;
  for (let inner = active && (active.shadowRoot ?? recorded?.get(active))?.activeElement; inner; inner = (inner.shadowRoot ?? recorded?.get(inner))?.activeElement) active = inner;
  return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
}

/** A checkable's state and kind, as Playwright reads it: a checkable role without `aria-checked` is unchecked; `checked` is null for an element with no checked state. */
export function checkState(element: Element): { checked: boolean | null; radio: 'native' | 'aria' | null } {
  const role = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
  const input = element.nodeName === 'INPUT' ? (element as HTMLInputElement) : null;
  const radio = input?.type === 'radio' ? 'native' : role === 'radio' || role === 'menuitemradio' ? 'aria' : null;
  if (input !== null && (input.type === 'checkbox' || input.type === 'radio')) return { checked: input.checked, radio };
  if (['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'].includes(role)) return { checked: element.getAttribute('aria-checked') === 'true', radio };
  return { checked: null, radio };
}

/**
 * Fills an element as Playwright's `fill` does, with no key events: a text
 * field or editing host is focused, its content selected, and the value
 * inserted as one `insertText` edit (a delete for an empty value), so the app
 * sees the trusted `beforeinput` and `input` an edit fires. A date, color,
 * range, or similar input takes the value directly, with `input` and
 * `change`. Nothing changes until the element proved editable and took
 * focus. Returns null once filled, else why the element cannot be.
 */
export function fill(element: Element, value: string, key: string): string | null {
  const typed = ['', 'text', 'password', 'search', 'email', 'tel', 'url', 'number'];
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  const EventClass = (Reflect.get(globalThis, Symbol.for('e2e.bidi.Event')) as typeof Event | undefined) ?? Event;
  const fire = (target: Element): void => {
    target.dispatchEvent(new EventClass('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new EventClass('change', { bubbles: true }));
  };
  const focused = (): boolean => {
    (element as HTMLElement).focus();
    let active = document.activeElement;
    for (let inner = active && (active.shadowRoot ?? recorded?.get(active))?.activeElement; inner; inner = (inner.shadowRoot ?? recorded?.get(inner))?.activeElement) active = inner;
    return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
  };
  const field = element.nodeName === 'INPUT' || element.nodeName === 'TEXTAREA' ? (element as HTMLInputElement | HTMLTextAreaElement) : null;
  if (field !== null) {
    const type = field.nodeName === 'INPUT' ? (field as HTMLInputElement).type.toLowerCase() : 'textarea';
    if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) return `Input of type "${type}" cannot be filled`;
    if (field.disabled || field.readOnly) return 'element is not editable';
    if (type === 'number' && Number.isNaN(Number(value.trim()))) return 'Cannot type text into input[type=number]';
    if (!focused()) return 'element could not be focused';
    if (type !== 'textarea' && !typed.includes(type)) {
      const wanted = value.trim();
      field.value = wanted;
      if (type === 'color' ? field.value.toLowerCase() !== wanted.toLowerCase() : field.value !== wanted) return 'Malformed value';
      fire(field);
      return null;
    }
    field.select();
  } else if ((element as HTMLElement).isContentEditable) {
    if (!focused()) return 'element could not be focused';
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    return 'Element is not an <input>, <textarea> or [contenteditable] element';
  }
  const edited = value === '' ? document.execCommand('delete') : document.execCommand('insertText', false, value);
  const number = field !== null && field.nodeName === 'INPUT' && (field as HTMLInputElement).type === 'number';
  if (field !== null && (!edited || (number && field.value !== value))) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    fire(field);
  }
  if (number && field.value !== value) return 'Malformed value';
  return null;
}

/** Which option `selectOption` picks: by its label, value, or index. */
export interface OptionChoice {
  readonly label?: string;
  readonly value?: string;
  readonly index?: number;
}

/**
 * Selects the option of a `<select>` matching `by` and fires `input` and
 * `change`, as Playwright's `selectOption` does. Returns null once selected,
 * else why it cannot be.
 */
export function selectOption(element: Element, by: OptionChoice): string | null {
  if (element.nodeName !== 'SELECT') return 'Element is not a <select> element';
  const select = element as HTMLSelectElement;
  if (select.disabled) return 'element is not enabled';
  const options = [...select.options];
  const option = by.index !== undefined ? options[by.index]
    : by.value !== undefined ? options.find((each) => each.value === by.value)
    : options.find((each) => each.label === by.label || each.textContent?.trim() === by.label);
  if (option === undefined) return 'no option matches';
  if (option.disabled || option.closest('optgroup')?.disabled === true) return 'option being selected is not enabled';
  const EventClass = (Reflect.get(globalThis, Symbol.for('e2e.bidi.Event')) as typeof Event | undefined) ?? Event;
  select.focus();
  for (const each of options) each.selected = each === option;
  select.dispatchEvent(new EventClass('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new EventClass('change', { bubbles: true }));
  return null;
}

/** The file input an element is or labels; null for anything else. */
export function fileInput(element: Element): HTMLInputElement | null {
  const control = element instanceof HTMLInputElement ? element : element.closest('label')?.control;
  return control instanceof HTMLInputElement && control.type === 'file' ? control : null;
}

/** Whether a file input takes a directory (`webkitdirectory`). */
export function directoryInput(element: Element): boolean {
  return (element as HTMLInputElement).webkitdirectory === true;
}

/** An element's box size, which a swipe on it spans. */
export function boxSize(element: Element): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * Covers every secure field of the document, through open and recorded
 * closed shadow roots, with an opaque box, and hides the caret in the
 * document and each of those roots (as `screenshot-caret.ts` does), for one
 * screenshot; returns how many fields it covered. A field inside a top-layer
 * element (a modal dialog, an open popover, a fullscreen element, found
 * through the composed tree, slots included) gets its box inside that
 * element, in its scaled coordinates, so the box moves with it however the
 * app reorders the top layer; any other field's box (and one in a top-layer
 * element turned or mirrored) sits in a manual popover of its own, above
 * what the app shows. Boxes live in closed shadow roots of hosts whose every
 * style is set inline as `!important`, so no page rule reaches them. `token`
 * names this masking for `unmaskSecureFields`; captures that overlap each
 * keep their own.
 */
export function maskSecureFields(selector: string, key: string, token: string): number {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  const fields: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    fields.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) roots.push(shadow);
    }
  }
  const pin = (element: HTMLElement, styles: Record<string, string>): void => {
    element.style.setProperty('all', 'initial', 'important');
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  const parentOf = (at: Element): Element | null => {
    if (at.assignedSlot !== null) return at.assignedSlot;
    const closed = at.parentElement === null ? undefined : recorded?.get(at.parentElement);
    for (const slot of closed?.querySelectorAll('slot') ?? []) if (slot.assignedElements({ flatten: true }).includes(at)) return slot;
    return at.parentElement ?? (at.getRootNode() instanceof ShadowRoot ? (at.getRootNode() as ShadowRoot).host : null);
  };
  const scalesOnly = (from: Element): boolean => {
    for (let at: Element | null = from; at !== null; at = parentOf(at)) {
      const style = getComputedStyle(at);
      if (style.rotate !== 'none' || style.scale.includes('-')) return false;
      if (style.transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return false;
    }
    return true;
  };
  const layerOf = (field: Element): Element | null => {
    for (let at: Element | null = field; at !== null; at = parentOf(at)) {
      if (at.matches(':modal, :popover-open, :fullscreen')) return scalesOnly(at) ? at : null;
    }
    return null;
  };
  const hosts = new Map<Element | null, { host: HTMLElement; layer: ShadowRoot }>();
  const hostFor = (container: Element | null): { host: HTMLElement; layer: ShadowRoot } => {
    let made = hosts.get(container);
    if (made === undefined) {
      const host = document.createElement('e2e-mask');
      pin(host, {
        display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
        opacity: '1', visibility: 'visible', overflow: 'visible', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647',
      });
      if (container === null) {
        host.popover = 'manual';
        document.documentElement.append(host);
        host.showPopover();
      } else {
        container.append(host);
      }
      made = { host, layer: host.attachShadow({ mode: 'closed' }) };
      hosts.set(container, made);
    }
    return made;
  };
  const boxes: { field: Element; rect: DOMRect; box: HTMLElement }[] = [];
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const { host, layer } = hostFor(layerOf(field));
    const origin = host.getBoundingClientRect();
    const scaleX = host.offsetWidth > 0 ? origin.width / host.offsetWidth : 1;
    const scaleY = host.offsetHeight > 0 ? origin.height / host.offsetHeight : 1;
    const box = document.createElement('div');
    pin(box, {
      display: 'block', position: 'absolute',
      left: `${(rect.left - origin.left) / scaleX}px`, top: `${(rect.top - origin.top) / scaleY}px`, width: `${rect.width / scaleX}px`, height: `${rect.height / scaleY}px`,
      background: '#000', opacity: '1', visibility: 'visible', 'pointer-events': 'none',
    });
    layer.append(box);
    boxes.push({ field, rect, box });
  }
  const caret = new CSSStyleSheet();
  caret.replaceSync('input, textarea, [contenteditable] { caret-color: transparent !important; }');
  const sheeted = roots.filter((root): root is Document | ShadowRoot => root instanceof Document || root instanceof ShadowRoot);
  for (const root of sheeted) root.adoptedStyleSheets = [...root.adoptedStyleSheets, caret];
  const masks = (Reflect.get(globalThis, Symbol.for('e2e.bidi.mask')) as Map<string, unknown> | undefined) ?? new Map<string, unknown>();
  masks.set(token, { hosts: [...hosts].map(([container, { host }]) => ({ container, host })), caret, sheeted, boxes, selector, key });
  Reflect.set(globalThis, Symbol.for('e2e.bidi.mask'), masks);
  return boxes.length;
}

/**
 * Removes what `maskSecureFields` added. Returns whether the screenshot taken
 * between the two showed no secure field: this document holds the masking
 * under `token`, every host still where it was put (the popover still open,
 * each other host still inside its top-layer element) and painted opaque,
 * every box drawn over the whole of its field, every covered field where its
 * box was, and no visible secure field
 * appeared that no box covers.
 */
export function unmaskSecureFields(token: string): boolean {
  type Mask = {
    hosts: { container: Element | null; host: HTMLElement }[];
    caret: CSSStyleSheet;
    sheeted: (Document | ShadowRoot)[];
    boxes: { field: Element; rect: DOMRect; box: HTMLElement }[];
    selector: string;
    key: string;
  };
  const masks = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask')) as Map<string, Mask> | undefined;
  const mask = masks?.get(token);
  if (masks === undefined || mask === undefined) return false;
  masks.delete(token);
  const painted = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
  };
  const placed = ({ container, host }: Mask['hosts'][number]): boolean =>
    (container === null ? host.matches(':popover-open') : host.parentNode === container && container.matches(':modal, :popover-open, :fullscreen')) && painted(host);
  const covers = ({ field, box }: Mask['boxes'][number]): boolean => {
    const target = field.getBoundingClientRect();
    const drawn = box.getBoundingClientRect();
    return drawn.left <= target.left + 0.5 && drawn.top <= target.top + 0.5 && drawn.right >= target.right - 0.5 && drawn.bottom >= target.bottom - 0.5;
  };
  const shown = mask.hosts.every(placed) && mask.boxes.every((entry) => painted(entry.box) && covers(entry));
  for (const { host } of mask.hosts) host.remove();
  for (const root of mask.sheeted) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== mask.caret);
  if (!shown) return false;
  const still = mask.boxes.every(({ field, rect }) => {
    const now = field.getBoundingClientRect();
    return now.x === rect.x && now.y === rect.y && now.width === rect.width && now.height === rect.height;
  });
  const covered = new Set(mask.boxes.map(({ field }) => field));
  const recorded = Reflect.get(globalThis, Symbol.for(mask.key)) as WeakMap<Element, ShadowRoot> | undefined;
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    for (const field of root.querySelectorAll(mask.selector)) {
      const rect = field.getBoundingClientRect();
      if (!covered.has(field) && rect.width > 0 && rect.height > 0) return false;
    }
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) roots.push(shadow);
    }
  }
  return still;
}

/**
 * The history entry the document shows once it reads complete, null while
 * it loads: the Navigation API's entry key, else its URL and state.
 */
export function historyEntry(): string | null {
  if (document.readyState !== 'complete') return null;
  const key = (globalThis as { navigation?: { currentEntry?: { key?: string } | null } }).navigation?.currentEntry?.key;
  return key ?? `${location.href} ${JSON.stringify(history.state)}`;
}

/** The document's title. */
export function documentTitle(): string {
  return document.title;
}

/**
 * Installs, before the page's own scripts, the capture listeners the click
 * watch (`armHitInterceptor`) decides through, so no listener of the app
 * runs ahead of them (they do nothing until a watch is armed), and keeps the
 * page's own `Event` constructor for the driver's edits, which a page may
 * replace later.
 */
export const HIT_INTERCEPTOR_INIT_SCRIPT = `(() => {
  Reflect.set(globalThis, Symbol.for('e2e.bidi.Event'), Event);
  const active = Symbol.for('e2e.bidi.hit.active');
  const recorded = () => Reflect.get(globalThis, Symbol.for('e2e.closedShadowRoots'));
  const contains = (target, x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (let root = hit && (hit.shadowRoot ?? recorded()?.get(hit)); hit && root; root = hit.shadowRoot ?? recorded()?.get(hit)) {
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    for (let at = hit; at; at = at.assignedSlot ?? at.parentElement ?? (at.parentNode && at.parentNode.nodeType === 11 ? at.parentNode.host : null)) if (at === target) return true;
    return false;
  };
  const listener = (event) => {
    const watch = globalThis[active];
    if (!watch) return;
    if (watch.verdict === undefined) {
      const path = event.composedPath();
      const reached = path.includes(watch.target) || ('clientX' in event && contains(watch.target, event.clientX, event.clientY));
      const hit = path[0];
      watch.verdict = reached ? null : (hit && hit.nodeType === 1 ? '<' + hit.localName + (hit.id ? '#' + hit.id : '') + '>' : 'another element') + ' intercepts pointer events';
    }
    if (watch.verdict !== null) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu']) window.addEventListener(type, listener, { capture: true });
})();`;

/**
 * Arms the click watch the init script installed, for the input about to
 * reach `element`, as Playwright's hit target interceptor: the first press,
 * release, or click decides whether the input reaches the element
 * (retargeted to its button or link, through slots, shadow hosts, and
 * recorded closed roots), and every later one is suppressed when it did not.
 * `hitInterceptorResult` reads the decision.
 */
export function armHitInterceptor(element: Element): void {
  const target = element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable
    ? element
    : (element.closest('button, [role=button], a, [role=link]') ?? element);
  Reflect.set(globalThis, Symbol.for('e2e.bidi.hit.active'), { target, verdict: undefined });
}

/**
 * Ends the click watch: null when the input reached the element, or when
 * the document it was armed in is gone (the click navigated, so it landed);
 * why not when it did not; `unseen` when no input reached this document.
 */
export function hitInterceptorResult(): string | null {
  const watch = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.active')) as { verdict: string | null | undefined } | undefined;
  Reflect.deleteProperty(globalThis, Symbol.for('e2e.bidi.hit.active'));
  if (watch === undefined) return null;
  return watch.verdict === undefined ? 'unseen' : watch.verdict;
}

/**
 * Scrolls an element into view as Playwright's `scrollIntoViewIfNeeded`
 * does: once it holds still for a frame, and only when some of it is out of
 * the viewport or a scrolling ancestor (to its nearest edge there). In the
 * viewport each axis follows Chromium's center-if-needed, which Playwright's
 * rect scroll uses: a box wholly out is centred, a box partly out goes to
 * its closest edge, start unless it is smaller than the view and past its
 * end or larger and short of it. Any element with a box counts, a zero-sized or
 * `visibility: hidden` one included; a `display: contents` element counts by
 * the boxes of its contents. Returns `detached`, `hidden` when nothing lays
 * out a box yet (it may appear), `moving`, or `ok`.
 */
export async function scrollIntoViewIfNeeded(element: Element): Promise<'detached' | 'hidden' | 'moving' | 'ok'> {
  if (!element.isConnected) return 'detached';
  const bounds = (): DOMRect | null => {
    let rects = [...element.getClientRects()];
    if (rects.length === 0 && getComputedStyle(element).display === 'contents') {
      const range = document.createRange();
      range.selectNodeContents(element);
      rects = [...range.getClientRects()];
    }
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    return new DOMRect(left, top, Math.max(...rects.map((rect) => rect.right)) - left, Math.max(...rects.map((rect) => rect.bottom)) - top);
  };
  // Read in two frames whose animation time differs: a frame that repeats the time shows no motion.
  const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const first = await frame();
  const before = bounds();
  if (before === null) return 'hidden';
  for (let tries = 0; tries < 5 && (await frame()) === first; tries += 1);
  const rect = bounds();
  if (rect === null) return 'hidden';
  if (rect.x !== before.x || rect.y !== before.y || rect.width !== before.width || rect.height !== before.height) return 'moving';
  const outside = (area: { left: number; top: number; right: number; bottom: number }): boolean =>
    rect.left < area.left || rect.top < area.top || rect.right > area.right || rect.bottom > area.bottom;
  let container = false;
  for (let at = element.parentElement; !container && at !== null && at !== document.documentElement; at = at.parentElement) {
    if (getComputedStyle(at).overflow !== 'visible') container = outside(at.getBoundingClientRect());
  }
  const width = visualViewport?.width || innerWidth;
  const height = visualViewport?.height || innerHeight;
  const viewport = outside({ left: 0, top: 0, right: width, bottom: height });
  if (container || viewport) {
    const target = element.getClientRects().length > 0
      ? element
      : ([...element.querySelectorAll('*')].find((child) => child.getClientRects().length > 0) ?? element.parentElement);
    const axis = (start: number, end: number, view: number): ScrollLogicalPosition => {
      if (start >= 0 && end <= view) return 'nearest';
      if (end <= 0 || start >= view) return 'center';
      return (end > view && end - start < view) || (end < view && end - start > view) ? 'end' : 'start';
    };
    target?.scrollIntoView(container
      ? { block: 'nearest', inline: 'nearest', behavior: 'instant' }
      : { block: axis(rect.top, rect.bottom, height), inline: axis(rect.left, rect.right, width), behavior: 'instant' });
  }
  return 'ok';
}

/**
 * Inserts `text` where focus is in this document, as an IME would commit it
 * (Playwright's `insertText`): for a character no key of the keyboard types.
 * Returns false when this document does not hold focus, or its focus is an
 * iframe whose own document does.
 */
export function insertFocusedText(text: string): boolean {
  if (!document.hasFocus()) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active === null || active.nodeName === 'IFRAME' || active.nodeName === 'FRAME') return false;
  return document.execCommand('insertText', false, text);
}
