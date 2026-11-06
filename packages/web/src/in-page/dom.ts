/**
 * The DOM helpers the driver's page functions share: the flat-tree parent
 * walk, the turned-transform test, the hit test through shadow roots, the
 * pointer target an action retargets to, and focus through shadow roots.
 * Self-contained, so its source is spliced into each page function and
 * preload that needs it (`withDom` in `page.ts`), and each helper is
 * written once.
 */

/**
 * Builds the helpers over the closed shadow roots recorded under `key`
 * (none without one), read when a helper runs, so roots recorded after
 * the helpers were built count too.
 */
export function createDom(key?: string) {
  const recorded = (): WeakMap<Element, ShadowRoot> | undefined =>
    key === undefined ? undefined : (Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined);

  /** The element's open or recorded closed shadow root. */
  const shadowOf = (element: Element): ShadowRoot | null => element.shadowRoot ?? recorded()?.get(element) ?? null;

  /**
   * The element's parent in the flat tree: the slot it is assigned to (in a
   * recorded closed root too, whose slots still list what they hold), else
   * its parent element, else the host of the shadow root it is in.
   */
  const parentOf = (at: Element): Element | null => {
    if (at.assignedSlot !== null) return at.assignedSlot;
    const closed = at.parentElement === null ? undefined : recorded()?.get(at.parentElement);
    for (const slot of closed?.querySelectorAll('slot') ?? []) if (slot.assignedElements({ flatten: true }).includes(at)) return slot;
    const root = at.getRootNode();
    return at.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };

  /** Whether a rotation, skew, reflection, or 3D transform turns the element: its own, or a flat-tree ancestor's (`transform`, `rotate`, or a negative `scale`). */
  const turned = (from: Element): boolean => {
    for (let at: Element | null = from; at !== null; at = parentOf(at)) {
      const style = getComputedStyle(at);
      if (style.rotate !== 'none' || style.scale.includes('-')) return true;
      if (style.transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return true;
    }
    return false;
  };

  /** The element a pointer event for `element` must reach, as Playwright's hit check retargets it: the button or link that holds it, unless it is a field or an editing host. */
  const pointerTarget = (element: Element): Element =>
    element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable
      ? element
      : (element.closest('button, [role=button], a, [role=link]') ?? element);

  /** The element a pointer event at `x`, `y` of this document hits, descending through open and recorded closed shadow roots. */
  const hitAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    for (let root = hit === null ? null : shadowOf(hit); hit !== null && root !== null; root = shadowOf(hit)) {
      const inner = root.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  /** Whether an event on `hit` reaches `target`: `target` is `hit` or one of its flat-tree ancestors. */
  const reaches = (hit: Element, target: Element): boolean => {
    for (let at: Element | null = hit; at !== null; at = parentOf(at)) if (at === target) return true;
    return false;
  };

  /** The element holding focus in this document, followed through open and recorded closed shadow roots. */
  const activeElement = (): Element | null => {
    let active = document.activeElement;
    for (let inner = active === null ? null : shadowOf(active)?.activeElement; inner !== null && inner !== undefined; inner = shadowOf(inner)?.activeElement) active = inner;
    return active;
  };

  /** Focuses `element`; whether focus landed on it, or on the editing host that holds it. */
  const focus = (element: Element): boolean => {
    (element as HTMLElement).focus();
    const active = activeElement();
    return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
  };

  return { shadowOf, parentOf, turned, pointerTarget, hitAt, reaches, activeElement, focus };
}
