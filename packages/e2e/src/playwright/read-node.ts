/** In-page semantic node reader executed via locator.evaluate. */

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

/**
 * Serialized into the page by Playwright. Must stay self-contained: no outer
 * captures beyond its single argument.
 */
export const readNodeFunction = (element: Element, testIdAttribute: string): RawNodeData => {
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

  const el = element;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
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
  const secure = tag === 'input' && type === 'password';

  let inputPurpose: RawNodeData['inputPurpose'] = 'none';
  if (secure) inputPurpose = 'password';
  else if (autocomplete === 'username') inputPurpose = 'username';
  else if (autocomplete === 'current-password' || autocomplete === 'new-password') {
    inputPurpose = 'password';
  } else if (autocomplete === 'one-time-code') inputPurpose = 'one-time-code';

  const attributes: Record<string, string> = {};
  const allowedExact = [testIdAttribute, 'type', 'autocomplete', 'href', 'role', 'id', 'name', 'placeholder', 'title', 'alt', 'value'];
  for (const attribute of Array.from(el.attributes)) {
    if (allowedExact.includes(attribute.name) || attribute.name.startsWith('aria-')) {
      if (secure && attribute.name === 'value') continue;
      attributes[attribute.name] = attribute.value;
    }
  }

  const rect = el.getBoundingClientRect();

  return {
    role: implicitRole(el),
    name: accessibleName(el),
    text: secure ? '' : textOf(el),
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
