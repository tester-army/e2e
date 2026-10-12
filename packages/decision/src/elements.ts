import type { ExecutorNode, ExecutorPixels, StepExecutorContext } from 'e2e';
import { fnv1a } from './hash.ts';

/** Operations the executor offers on elements. */
export type Operation =
  | 'tap'
  | 'type'
  | 'typeSecret'
  | 'submit'
  | 'select'
  | 'check'
  | 'hover'
  | 'secondary_tap'
  | 'double_tap'
  | 'long_press'
  | 'drag'
  | 'scroll_to'
  | 'upload'
  | 'tap_at';
/**
 * Viewport, history, and keyboard controls, offered when the engine declares
 * the verb; `dismiss_keyboard` only while an on-screen keyboard is showing.
 */
export type Control = 'scroll_up' | 'scroll_down' | 'back' | 'dismiss_keyboard';
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
  readonly selected?: boolean;
  readonly operations: readonly Operation[];
}

/** One target of an operation: the node it acts on, as data. The model only ever names the key. */
export interface Target {
  readonly id: string;
  /** How the action reads in history, e.g. `tap Save [n4]`. */
  readonly description: string;
  /** Native-select option label, set only for `select` options; names the choice criterion. */
  readonly optionLabel?: string;
  /** The checked state a `check` flips. */
  readonly checked?: boolean;
}

/** One drop destination for `drag`, keyed like an element. */
export interface Destination {
  readonly id: string;
  readonly label: string;
  readonly role: string;
}

export interface ActionSpace {
  readonly elements: readonly Element[];
  /** The element behind a target key, for labels and field descriptions. */
  element(key: string): Element | undefined;
  /** Per operation: target key -> target. Only operations with at least one target appear. */
  readonly targets: ReadonlyMap<Operation, ReadonlyMap<string, Target>>;
  readonly controls: ReadonlySet<Control>;
  /** The operation or control an answer names, typed; undefined for anything not offered. */
  operation(choice: string): Operation | undefined;
  control(choice: string): Control | undefined;
  /** Where a `drag` can drop, by element key; empty when nothing can receive a drop. */
  readonly destinations: ReadonlyMap<string, Destination>;
  /** Whether `tap_at` is offered: a screenshot, the `tapAt` verb, and a step that locates. */
  readonly tapAt: boolean;
  /** Elements left out to stay under the per-question cap; scrolling can bring them into view. */
  readonly omitted: number;
  /** Non-interactive page text from the tree, without node ids, clipped to 6000 chars. */
  readonly pageText: string;
  /** Live regions (status, alert, log) as `name: text`, the lines a completion check reads first. */
  readonly statuses: readonly string[];
  /** Stable hash of path, tree content with node ids removed, and which nodes are in view. */
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
/** Roles a device tree gives the soft keyboard and its keys; an iOS number pad lists only its keys. */
const keyboardRoles = new Set(['keyboard', 'key']);
/** Live regions whose text reports what the app just did; a log can run long, so each line and their count are bounded. */
const liveRegions = new Set(['status', 'alert', 'log']);
const MAX_STATUSES = 20;
const MAX_STATUS_LENGTH = 300;
/** Roles that can receive a dropped node. */
const droppable = new Set(['region', 'list', 'listitem', 'group', 'cell', 'gridcell', 'row', 'article', 'section', 'tabpanel']);
/**
 * Roles of nodes that are no control yet take a pointer: a card that opens
 * a menu on hover, a file row that takes a right-click, a paragraph to
 * scroll to, a column to drop on. The empty role is a plain text node.
 */
const passiveRoles = new Set([
  '',
  'listitem',
  'article',
  'region',
  'group',
  'cell',
  'gridcell',
  'row',
  'img',
  'figure',
  'heading',
  'paragraph',
  'list',
  'section',
  'tabpanel',
]);

/** The parts of an observation the action space reads. */
interface SpaceObservation {
  readonly path?: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly tree: ExecutorNode;
  /** Granted pixels; with the `tapAt` verb and a step that locates they open `tap_at`. */
  readonly pixels?: ExecutorPixels;
  /** Whether the step can locate a drawn control on the pixels: the decision model scores and a text model names it. */
  readonly locates?: boolean;
}

/** Builds the element table and bound targets from the newest observation. */
export function actionSpace(ctx: StepExecutorContext, observation: SpaceObservation, canType: boolean): ActionSpace {
  const verbs = ctx.target.verbs;
  interface Row {
    node: ExecutorNode;
    operations: Operation[];
    inViewport: boolean;
    /** The row holds no control of its own; it is listed for a pointer or scroll operation. */
    passive: boolean;
  }
  const rows: Row[] = [];
  const pageText: string[] = [];
  const statuses: string[] = [];
  /** Walks the tree, collecting interactive rows and page text. */
  const visit = (node: ExecutorNode, underNativeSelect: boolean): void => {
    if (node.states?.disabled !== true && node.states?.hidden !== true) {
      const operations: Operation[] = [];
      const role = node.role ?? '';
      const password = node.inputPurpose === 'password' || node.states?.secure === true;
      const nativeSelect = role === 'combobox' && (node.children ?? []).some((child) => child.role === 'option');
      const childSelect = underNativeSelect || nativeSelect;
      const checkedRadio = role === 'radio' && node.states?.checked === true;
      const fileInput = node.attributes?.['type'] === 'file';
      const inViewport = intersects(node, observation.viewport);
      const pressable = tappable.has(role) && !checkable.has(role) && !(role === 'option' && childSelect) && !fileInput;
      if (verbs.has('tap') && pressable) operations.push('tap');
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
      // Paths come from the text model, as typed values do.
      if (verbs.has('upload') && fileInput && canType) operations.push('upload');
      const interactive = operations.length > 0;
      if (pressable) {
        if (verbs.has('doubleTap')) operations.push('double_tap');
        if (verbs.has('longPress')) operations.push('long_press');
      }
      // Pointer and scroll operations reach any labeled node, not only
      // controls: a card menu that opens on hover, a file row that takes a
      // right-click, a footnote to bring into view.
      const pointable = (interactive || (passiveRoles.has(role) && !childSelect)) && nodeLabel(node) !== '' && node !== observation.tree;
      if (pointable) {
        if (verbs.has('hover')) operations.push('hover');
        if (verbs.has('secondaryTap')) operations.push('secondary_tap');
        if (verbs.has('drag')) operations.push('drag');
        if (verbs.has('scrollTo') && node.rect !== undefined && !inViewport) operations.push('scroll_to');
      }
      if (operations.length > 0) {
        rows.push({ node, operations, inViewport, passive: !interactive });
      }
      if (!interactive) {
        const line = pageLine(node);
        // A checked radio leaves the table, so its state rides on the page text.
        if (line !== '') pageText.push(checkedRadio ? `${line} (checked)` : line);
        if (liveRegions.has(role) && statuses.length < MAX_STATUSES) {
          const text = (node.text ?? '').replace(/\s+/g, ' ').trim();
          if (text !== '') statuses.push(clip(`${(node.name ?? '').trim() || role}: ${text}`, MAX_STATUS_LENGTH));
        }
      }
    }
    for (const child of node.children ?? []) visit(child, underNativeSelect || node.role === 'combobox');
  };
  visit(observation.tree, false);
  // Controls before passive rows, viewport nodes first within each, then
  // tree order; drop the rest past the cap so the model can scroll to them,
  // and never block on a large screen. A control below the fold still
  // outranks any amount of visible prose.
  const ordered = [...rows]
    .map((row, order) => ({ row, order }))
    .toSorted((a, b) =>
      Number(a.row.passive) - Number(b.row.passive) || Number(b.row.inViewport) - Number(a.row.inViewport) || a.order - b.order,
    )
    .map(({ row }) => row);
  const omitted = Math.max(0, ordered.length - MAX_CHOICES);
  const kept = ordered.slice(0, MAX_CHOICES);
  // Drop targets come from the kept rows: a drag with nowhere to drop is no operation.
  const destinations = new Map<string, Destination>();
  if (verbs.has('drag')) {
    for (const [position, row] of kept.entries()) {
      const role = row.node.role ?? '';
      const label = clip(nodeLabel(row.node), 120);
      if (droppable.has(role) && label !== '') destinations.set(String(position + 1), { id: row.node.id, label, role });
    }
  }
  const targets = new Map<Operation, Map<string, Target>>();
  const byIndex = new Map<string, Element>();
  let selectCount = 0;
  const elements: Element[] = kept.map((row, position) => {
    const index = String(position + 1);
    const label = clip(nodeLabel(row.node), 120);
    const role = row.node.role ?? '';
    const operations = destinations.size === 0 ? row.operations.filter((operation) => operation !== 'drag') : row.operations;
    for (const operation of operations) {
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
          options.set(key, { id: row.node.id, description: `select option ${JSON.stringify(optionLabel)} in ${named(role, label)}`, optionLabel });
          selectCount += 1;
        }
        if (options.size > 0) {
          const group = targets.get('select') ?? new Map<string, Target>();
          for (const [key, target] of options) group.set(key, target);
          targets.set('select', group);
        }
      } else {
        const group = targets.get(operation) ?? new Map<string, Target>();
        group.set(index, {
          id: row.node.id,
          description: `${VERBS[operation]} ${named(role, label)}`,
          ...(row.node.states?.checked === undefined ? {} : { checked: row.node.states.checked }),
        });
        targets.set(operation, group);
      }
    }
    const element: Element = {
      index,
      role,
      label,
      ...(row.node.value === undefined ? {} : { value: row.node.value }),
      ...(row.node.states?.checked === undefined ? {} : { checked: row.node.states.checked }),
      ...(row.node.states?.expanded === undefined ? {} : { expanded: row.node.states.expanded }),
      ...(row.node.states?.selected === undefined ? {} : { selected: row.node.states.selected }),
      operations,
    };
    byIndex.set(index, element);
    return element;
  });
  const tapAt = observation.pixels !== undefined && observation.locates === true && verbs.has('tapAt');
  const controls = new Set<Control>();
  if (verbs.has('scroll')) {
    controls.add('scroll_up');
    controls.add('scroll_down');
  }
  if (verbs.has('back')) controls.add('back');
  if (verbs.has('dismissKeyboard') && keyboardShowing(observation.tree)) controls.add('dismiss_keyboard');
  return {
    elements,
    element: (key) => byIndex.get(targetKeyIndex(key)),
    targets,
    controls,
    operation: (choice) => (targets.has(choice as Operation) || (tapAt && choice === 'tap_at') ? (choice as Operation) : undefined),
    control: (choice) => (controls.has(choice as Control) ? (choice as Control) : undefined),
    destinations,
    tapAt,
    omitted,
    pageText: clip(pageText.join('\n'), 6000),
    statuses,
    fingerprint: fingerprint(observation.path ?? '', observation.tree, observation.viewport, observation.pixels),
  };
}
/**
 * A node as an action line names it: `checkbox "Agree to terms"`. Measured
 * on gpt-6-luna over captured requests, the role and the quoted label lift
 * a completion verdict the bare label with a node id left inconclusive
 * (holds 0.17 to 0.83 on a checked checkbox), with no loss on the
 * operation questions.
 */
function named(role: string, label: string): string {
  return role === '' ? JSON.stringify(label) : `${role} ${JSON.stringify(label)}`;
}
/** How each operation reads in a target description and in history. */
const VERBS: Readonly<Record<Operation, string>> = {
  select: 'select',
  tap_at: 'tap at',
  tap: 'tap',
  type: 'type into',
  typeSecret: 'typeSecret into',
  submit: 'submit',
  check: 'check',
  hover: 'hover',
  secondary_tap: 'right-click',
  double_tap: 'double-tap',
  long_press: 'long-press',
  scroll_to: 'scroll to',
  upload: 'upload to',
  drag: 'drag',
};
/** Element index behind a target key (`7` for both `7` and `7:2`). */
export function targetKeyIndex(key: string): string {
  const at = key.indexOf(':');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * Whether the tree lists an on-screen keyboard. Offering the control only
 * then keeps a choice that does nothing out of the operation question.
 */
function keyboardShowing(node: ExecutorNode): boolean {
  if (node.states?.hidden === true) return false;
  if (keyboardRoles.has(node.role ?? '')) return true;
  return (node.children ?? []).some(keyboardShowing);
}

/** Label the model reads: name, placeholder, or text. */
function nodeLabel(node: ExecutorNode): string {
  return node.name ?? node.attributes?.['placeholder'] ?? node.text ?? '';
}

/**
 * One page-text line for a non-interactive node. A named node keeps its text
 * when the two differ, as the runner's `formatNode` does: a status named
 * "Greeting" whose text says "Welcome back, admin!" is the evidence a
 * completion check needs, and the name alone hides it.
 */
function pageLine(node: ExecutorNode): string {
  const name = (node.name ?? '').trim();
  const text = (node.text ?? '').replace(/\s+/g, ' ').trim();
  if (name === '') return text === '' ? (node.attributes?.['placeholder'] ?? '').trim() : text;
  return text === '' || text === name ? name : `${name} text=${JSON.stringify(text)}`;
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

/**
 * Stable hash of the path, the tree content with node ids removed, whether
 * each node meets the viewport, and the pixels when the step sees them. Ids
 * change on every capture, so they stay out. In-view membership lets a
 * scroll that brings other nodes into view count as progress, while one
 * that moves nothing (the page bottom) still reads as unchanged; raw
 * coordinates stay out so small layout shifts do not count. Pixels are in
 * because a drawn control changes nothing in the tree: a keypad digit
 * entered on a canvas is progress only the screenshot shows.
 */
function fingerprint(path: string, tree: ExecutorNode, viewport: { width: number; height: number }, pixels?: ExecutorPixels): string {
  const parts: (string | Uint8Array)[] = [path];
  if (pixels !== undefined) parts.push(pixels.data);
  const visit = (node: ExecutorNode): void => {
    parts.push(node.role ?? '', node.name ?? '', node.text ?? '', node.value ?? '', JSON.stringify(node.states ?? null), JSON.stringify(node.attributes ?? null), intersects(node, viewport) ? 'v' : '-');
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return fnv1a(parts);
}
