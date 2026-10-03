import type { ExecutorNode, StepExecutorContext } from 'e2e';

/** Operations the executor offers on elements. */
export type Operation = 'tap' | 'type' | 'typeSecret' | 'submit' | 'select' | 'check';
/** Viewport and history controls, always offered when the engine declares the verb. */
export type Control = 'scroll_up' | 'scroll_down' | 'back';
/** Terminal choices: the step claims completion, reports a product failure, or gives up. */
export type Terminal = 'done' | 'failed' | 'blocked';

/** One row of the element table the decision model reads. */
export interface Element {
  readonly index: string;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly operations: readonly Operation[];
}

/** A bound target. `run` calls `ctx.actions`; the model only ever names the key. */
export interface Target {
  readonly description: string;
  /** Text for `type`, the secret name for `typeSecret`, nothing otherwise. */
  run(argument?: string): Promise<void>;
  /** Native-select option label, set only for `select` options; names the choice criterion. */
  readonly optionLabel?: string;
}

export interface ActionSpace {
  readonly elements: readonly Element[];
  /** Per operation: target key -> bound target. Only operations with at least one target appear. */
  readonly targets: ReadonlyMap<Operation, ReadonlyMap<string, Target>>;
  readonly controls: ReadonlyMap<Control, Target>;
  /** Elements left out to stay under the per-question cap; scrolling can bring them into view. */
  readonly omitted: number;
  /** Non-interactive page text from the tree, without node ids, clipped to 6000 chars. */
  readonly pageText: string;
  /** Stable hash of path plus tree content with node ids removed. */
  readonly fingerprint: string;
}

/** TypeSafe's per-question choice limit; the AI SDK itself has none. */
const MAX_CHOICES = 255;

const tappable = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
]);
const typable = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
const secretTypable = new Set(['textbox', 'searchbox', 'combobox']);
const checkable = new Set(['checkbox', 'radio', 'switch']);

/** The parts of an observation the action space reads. */
interface SpaceObservation {
  readonly path?: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly tree: ExecutorNode;
}

/** Builds the element table and bound targets from the newest observation. */
export function actionSpace(ctx: StepExecutorContext, observation: SpaceObservation, canType: boolean): ActionSpace {
  const verbs = ctx.target.verbs;
  interface Row {
    node: ExecutorNode;
    operations: Operation[];
    inViewport: boolean;
  }
  const rows: Row[] = [];
  const pageText: string[] = [];
  /** Walks the tree, collecting interactive rows and page text. */
  const visit = (node: ExecutorNode, underNativeSelect: boolean): void => {
    if (node.states?.disabled !== true && node.states?.hidden !== true) {
      const operations: Operation[] = [];
      const role = node.role ?? '';
      const password = node.inputPurpose === 'password' || node.states?.secure === true;
      const nativeSelect = role === 'combobox' && (node.children ?? []).some((child) => child.role === 'option');
      const childSelect = underNativeSelect || nativeSelect;
      const checkedRadio = role === 'radio' && node.states?.checked === true;
      if (verbs.has('tap') && tappable.has(role) && !checkable.has(role) && !(role === 'option' && childSelect)) {
        operations.push('tap');
      }
      if (typable.has(role) && !nativeSelect) {
        if (!password && verbs.has('type') && canType) operations.push('type');
        if (verbs.has('typeSecret') && secretTypable.has(role) && ctx.step.secrets.length > 0) {
          operations.push('typeSecret');
        }
        if (!password && verbs.has('press')) operations.push('submit');
      }
      if (verbs.has('select') && nativeSelect) operations.push('select');
      // `check` toggles, so a checked radio would be unchecked: offer radios only when unchecked.
      if (verbs.has('check') && checkable.has(role) && !checkedRadio) operations.push('check');
      if (operations.length > 0) {
        rows.push({ node, operations, inViewport: intersects(node, observation.viewport) });
      } else {
        const text = node.name ?? node.attributes?.['placeholder'] ?? node.text ?? '';
        // A checked radio leaves the table, so its state rides on the page text.
        if (text.trim() !== '') pageText.push(checkedRadio ? `${text} (checked)` : text);
      }
    }
    for (const child of node.children ?? []) visit(child, underNativeSelect || node.role === 'combobox');
  };
  visit(observation.tree, false);
  // Viewport nodes first, then tree order; drop the rest past the cap so
  // the model can scroll to them, and never block on a large screen.
  const ordered = [...rows]
    .map((row, order) => ({ row, order }))
    .toSorted((a, b) => Number(b.row.inViewport) - Number(a.row.inViewport) || a.order - b.order)
    .map(({ row }) => row);
  const omitted = Math.max(0, ordered.length - MAX_CHOICES);
  const kept = ordered.slice(0, MAX_CHOICES);
  const targets = new Map<Operation, Map<string, Target>>();
  let selectCount = 0;
  const elements: Element[] = kept.map((row, position) => {
    const index = String(position + 1);
    const label = clip(nodeLabel(row.node), 120);
    for (const operation of row.operations) {
      if (operation === 'select') {
        const options = new Map<string, Target>();
        for (const [optionIndex, child] of (row.node.children ?? []).entries()) {
          if (child.role !== 'option') continue;
          // An option the page hides or disables is no choice: the native
          // select cannot perform it, so the model must never see it.
          if (child.states?.hidden === true || child.states?.disabled === true) continue;
          // Every select shares one target group and one question, so options
          // stop at the per-question cap. They stay out of `omitted`: scrolling
          // never reveals an option the cap dropped.
          if (selectCount >= MAX_CHOICES) continue;
          const key = `${index}:${optionIndex}`;
          const optionLabel = child.name ?? child.text ?? '';
          options.set(key, {
            description: `select option ${JSON.stringify(optionLabel)} in ${label} [${row.node.id}]`,
            optionLabel,
            run: () => ctx.actions.select({ id: row.node.id }, optionLabel),
          });
          selectCount += 1;
        }
        if (options.size > 0) {
          const group = targets.get('select') ?? new Map<string, Target>();
          for (const [key, target] of options) group.set(key, target);
          targets.set('select', group);
        }
      } else {
        const key = index;
        const target: Target = bind(row.node, operation, label, ctx);
        const group = targets.get(operation) ?? new Map<string, Target>();
        group.set(key, target);
        targets.set(operation, group);
      }
    }
    return {
      index,
      role: row.node.role ?? '',
      label,
      ...(row.node.value === undefined ? {} : { value: row.node.value }),
      ...(row.node.states?.checked === undefined ? {} : { checked: row.node.states.checked }),
      ...(row.node.states?.expanded === undefined ? {} : { expanded: row.node.states.expanded }),
      operations: row.operations,
    };
  });
  const controls = new Map<Control, Target>();
  if (verbs.has('scroll')) {
    controls.set('scroll_up', { description: 'scroll viewport up', run: () => ctx.actions.scroll('up') });
    controls.set('scroll_down', { description: 'scroll viewport down', run: () => ctx.actions.scroll('down') });
  }
  if (verbs.has('back')) {
    controls.set('back', { description: 'back one step in history', run: () => ctx.actions.back() });
  }
  return {
    elements,
    targets,
    controls,
    omitted,
    pageText: clip(pageText.join('\n'), 6000),
    fingerprint: fingerprint(observation.path ?? '', observation.tree),
  };
}

/** Binds one element operation to the runner's actions. */
function bind(node: ExecutorNode, operation: Operation, label: string, ctx: StepExecutorContext): Target {
  const target = { id: node.id };
  const where = `${label} [${node.id}]`;
  switch (operation) {
    case 'tap':
      return { description: `tap ${where}`, run: () => ctx.actions.tap(target) };
    case 'type':
      return { description: `type into ${where}`, run: (argument = '') => ctx.actions.type(target, argument) };
    case 'typeSecret':
      return { description: `typeSecret into ${where}`, run: (argument = '') => ctx.actions.typeSecret(target, argument) };
    case 'submit':
      return { description: `submit ${where}`, run: () => ctx.actions.press(target, 'Enter') };
    case 'check':
      return { description: `check ${where}`, run: () => ctx.actions.check(target, !(node.states?.checked ?? false)) };
    case 'select': throw new Error('select binds per option, not per element');
  }
}

/** Label the model reads: name, placeholder, or text. */
function nodeLabel(node: ExecutorNode): string {
  return node.name ?? node.attributes?.['placeholder'] ?? node.text ?? '';
}

/** Whether the node's box meets the viewport. Nodes without a box stay in tree order. */
function intersects(node: ExecutorNode, viewport: { width: number; height: number }): boolean {
  const rect = node.rect;
  if (rect === undefined) return false;
  return rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Stable hash of path plus tree content with node ids removed. */
function fingerprint(path: string, tree: ExecutorNode): string {
  let hash = 2166136261;
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  feed(path);
  feed('\0');
  const visit = (node: ExecutorNode): void => {
    feed(node.role ?? '');
    feed('\0');
    feed(node.name ?? '');
    feed('\0');
    feed(node.text ?? '');
    feed('\0');
    feed(node.value ?? '');
    feed('\0');
    feed(JSON.stringify(node.states ?? null));
    feed('\0');
    feed(JSON.stringify(node.attributes ?? null));
    feed('\0');
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return (hash >>> 0).toString(36);
}
