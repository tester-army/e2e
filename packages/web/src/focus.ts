/** The page-side focus check both drivers run before typing into whatever holds focus. */

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
