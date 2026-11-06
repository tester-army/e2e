/**
 * Page functions the driver calls with `script.callFunction`. Each is a
 * self-contained function serialized with `toString()`, so none closes over
 * module scope; those that share DOM helpers take them through `withDom`.
 * The readers a document keeps live in `readers.ts`.
 */

import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import { createDom } from './dom.ts';

/**
 * A page function that takes the shared DOM helpers' factory (`createDom`)
 * before the arguments the driver passes. Its source hands it the factory's
 * own source, so it stays self-contained and the driver calls it with its
 * arguments alone; it only runs in a page.
 */
function withDom<A extends unknown[], R>(fn: (domOf: typeof createDom, ...args: A) => R): (...args: A) => R {
  const source = `(...args) => (${fn.toString()})((${createDom.toString()}), ...args)`;
  const inPageOnly = (..._args: A): R => {
    throw new Error('a page function runs only in the page');
  };
  return Object.assign(inPageOnly, { toString: () => source });
}

/** Where an action can land on an element, or why it cannot yet. */
export type ActionPoint =
  | { readonly state: 'ok'; readonly x: number; readonly y: number }
  | { readonly state: 'detached' | 'hidden' | 'disabled' | 'moving' | 'outside' };

/** What `actionPoint` checks: `scroll` to bring the element into view first; `key` names the closed-roots registry. */
export interface ActionPointOptions {
  readonly scroll: boolean;
  /** False to skip waiting for the element to hold still, for a frame scrolled into view on the way to the element inside it. */
  readonly stable?: boolean;
  /** How to scroll the element into view, for a retry after an overlay covered it; unset, only when its point is clipped. */
  readonly align?: { readonly block: ScrollLogicalPosition; readonly inline: ScrollLogicalPosition };
  readonly key: string;
}

/**
 * The checks Playwright runs before a pointer action, but the hit test and
 * the enabled check (the `disabled` reader): attached, visible, scrolled into view when its point is clipped by the
 * viewport or a scrolling ancestor (or as `align` says), and holding still
 * for a frame (unless `stable` is false). The point is the centre of the element's first client rect
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
  if (options.stable !== false) {
    // Read in two frames whose animation time differs: a frame that repeats the time shows no motion.
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const first = await frame();
    const before = rectsOf()[0] ?? element.getBoundingClientRect();
    for (let tries = 0; tries < 5 && (await frame()) === first; tries += 1);
    const after = rectsOf()[0] ?? element.getBoundingClientRect();
    if (after.x !== before.x || after.y !== before.y || after.width !== before.width || after.height !== before.height) return { state: 'moving' };
  }
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
 * Whether the element shows, as `actionPoint` reads it before anything
 * about a pointer: attached, laying out a box, and not `visibility: hidden`.
 * For an action that types or selects, which needs no point.
 */
export function elementShown(element: Element): 'detached' | 'hidden' | 'ok' {
  if (!element.isConnected) return 'detached';
  const style = getComputedStyle(element);
  let box: DOMRect | undefined = element.getClientRects()[0];
  if (box === undefined && style.display === 'contents') {
    const range = document.createRange();
    range.selectNodeContents(element);
    box = range.getClientRects()[0];
  }
  box ??= element.getBoundingClientRect();
  return box.width === 0 || box.height === 0 || style.visibility === 'hidden' ? 'hidden' : 'ok';
}

/**
 * Why a pointer event at `x`, `y` of the element's document would not reach
 * the element, descending through open and recorded closed shadow roots to
 * the element actually hit; null when it would. As Playwright's hit check,
 * the element is first retargeted to the button or link that holds it (a
 * label inside a button lets the button take the event), and the hit
 * element's ancestors are walked through the slots it is assigned to.
 */
export const hitBlocker = withDom((domOf, element: Element, x: number, y: number, key: string): string | null => {
  const dom = domOf(key);
  const hit = dom.hitAt(x, y);
  if (hit === null) return 'no element receives pointer events at the action point';
  return dom.reaches(hit, dom.pointerTarget(element)) ? null : `<${hit.localName}${hit.id === '' ? '' : `#${hit.id}`}> intercepts pointer events`;
});

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

/** Where a wheel reaches an element, with the box it read when nothing blocked it. */
export type WheelAim =
  | { readonly aim: 'pointer' | 'centre'; readonly box: { x: number; y: number; width: number; height: number } }
  | { readonly aim: 'blocked' };

/**
 * Where a wheel reaches `element` in a top-level document, whose box is the
 * viewport's: at the pointer when it already hovers the element, at its
 * centre when the hit target there is the element or inside it, else
 * `blocked`, which the full actionability checks answer.
 */
export function wheelAim(element: Element): WheelAim {
  if (window !== window.top || !element.isConnected || element.getClientRects().length === 0) return { aim: 'blocked' };
  const rect = element.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (element.matches(':hover')) return { aim: 'pointer', box };
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return hit !== null && element.contains(hit) ? { aim: 'centre', box } : { aim: 'blocked' };
}

/** Resolves after the next rendered frame, or at once in a hidden document. */
export function nextFrame(): Promise<void> | undefined {
  if (document.visibilityState === 'hidden') return undefined;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** Resolves true after the next rendered frame, or false at once in a hidden document, which renders none. */
export function shownFrame(): Promise<boolean> | boolean {
  if (document.visibilityState === 'hidden') return false;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(true), 0)));
}

/**
 * Focuses an element; returns whether focus landed on it, or on the editing
 * host that holds it, followed through open and recorded closed shadow roots.
 */
export const focus = withDom((domOf, element: Element, key: string): boolean => domOf(key).focus(element));

/** A checkable's state and kind, as Playwright reads it: a checkable role without `aria-checked` is unchecked; `checked` is null for an element with no checked state, and an element out of the document is `detached`. */
export function checkState(element: Element): { checked: boolean | null; radio: 'native' | 'aria' | null } | 'detached' {
  if (!element.isConnected) return 'detached';
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
export const fill = withDom((domOf, element: Element, value: string, key: string): string | null => {
  const typed = ['', 'text', 'password', 'search', 'email', 'tel', 'url', 'number'];
  const dom = domOf(key);
  const EventClass = (Reflect.get(globalThis, Symbol.for('e2e.bidi.Event')) as typeof Event | undefined) ?? Event;
  const fire = (target: Element): void => {
    target.dispatchEvent(new EventClass('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new EventClass('change', { bubbles: true }));
  };
  const field = element.nodeName === 'INPUT' || element.nodeName === 'TEXTAREA' ? (element as HTMLInputElement | HTMLTextAreaElement) : null;
  if (field !== null) {
    const type = field.nodeName === 'INPUT' ? (field as HTMLInputElement).type.toLowerCase() : 'textarea';
    if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) return `Input of type "${type}" cannot be filled`;
    if (field.disabled || field.readOnly) return 'element is not editable';
    if (type === 'number' && Number.isNaN(Number(value.trim()))) return 'Cannot type text into input[type=number]';
    if (!dom.focus(element)) return 'element could not be focused';
    if (type !== 'textarea' && !typed.includes(type)) {
      const wanted = value.trim();
      field.value = wanted;
      if (type === 'color' ? field.value.toLowerCase() !== wanted.toLowerCase() : field.value !== wanted) return 'Malformed value';
      fire(field);
      return null;
    }
    field.select();
  } else if ((element as HTMLElement).isContentEditable) {
    if (!dom.focus(element)) return 'element could not be focused';
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
});

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

/** An element's box size, which a swipe on it spans; null for one that lays out no box of its own (`display: contents`). */
export function boxSize(element: Element): { width: number; height: number } | null {
  if (element.getClientRects().length === 0) return null;
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
export const maskSecureFields = withDom((domOf, selector: string, key: string, token: string): number => {
  const dom = domOf(key);
  const fields: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    fields.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      const shadow = dom.shadowOf(element);
      if (shadow !== null) roots.push(shadow);
    }
  }
  const pin = (element: HTMLElement, styles: Record<string, string>): void => {
    element.style.setProperty('all', 'initial', 'important');
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  const layerOf = (field: Element): Element | null => {
    for (let at: Element | null = field; at !== null; at = dom.parentOf(at)) {
      if (at.matches(':modal, :popover-open, :fullscreen')) return dom.turned(at) ? null : at;
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
});

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

/** The document's ready state. */
export function readyState(): DocumentReadyState {
  return document.readyState;
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
  const dom = (${createDom.toString()})(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)});
  const contains = (target, x, y) => {
    const hit = dom.hitAt(x, y);
    return hit !== null && dom.reaches(hit, target);
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
export const armHitInterceptor = withDom((domOf, element: Element): void => {
  Reflect.set(globalThis, Symbol.for('e2e.bidi.hit.active'), { target: domOf().pointerTarget(element), verdict: undefined });
});

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
export const insertFocusedText = withDom((domOf, text: string): boolean => {
  if (!document.hasFocus()) return false;
  const active = domOf().activeElement();
  if (active === null || active.nodeName === 'IFRAME' || active.nodeName === 'FRAME') return false;
  return document.execCommand('insertText', false, text);
});

/**
 * Whether the focused element of this document takes keystrokes, following
 * focus into open and recorded closed shadow roots. Runs in the page, so it
 * stays self-contained; `key` names the closed-roots registry.
 */
export function focusTakesKeys(key: string): boolean {
  const recorded: WeakMap<Element, ShadowRoot> | undefined = Reflect.get(globalThis, Symbol.for(key));
  let active = document.activeElement;
  while (active !== null) {
    const root = active.shadowRoot ?? recorded?.get(active);
    const leaf = root?.activeElement;
    if (leaf === undefined || leaf === null) break;
    active = leaf;
  }
  if (active === null || active === document.body || active === document.documentElement) return false;
  if (active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(active.type);
  }
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  if (active instanceof HTMLSelectElement || active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement ||
      active instanceof HTMLIFrameElement || active instanceof HTMLFrameElement) {
    return false;
  }
  return true;
}

/**
 * Where a frame element's content box, the box its document's viewport
 * fills, sits inside its border box: past the border and the padding. Runs in
 * the page.
 */
export function frameContentInset(element: Element): { x: number; y: number; width: number; height: number } {
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.paddingLeft) || 0;
  const top = Number.parseFloat(style.paddingTop) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  return {
    x: element.clientLeft + left,
    y: element.clientTop + top,
    width: Math.max(0, element.clientWidth - left - right),
    height: Math.max(0, element.clientHeight - top - bottom),
  };
}
