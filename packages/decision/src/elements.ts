import type { ExecutorNode, ExecutorPixels, StepExecutorContext } from 'e2e';

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
  /**
   * Text for `type`, the secret name for `typeSecret`, paths for `upload`,
   * the destination key for `drag`, nothing otherwise. Resolves to what the
   * engine reported when that tells the model something (a point tap's
   * landing), nothing otherwise.
   */
  run(argument?: string | readonly string[]): Promise<string | undefined>;
  /** Native-select option label, set only for `select` options; names the choice criterion. */
  readonly optionLabel?: string;
}

/** One drop destination for `drag`, keyed like an element. */
export interface Destination {
  readonly id: string;
  readonly label: string;
  readonly role: string;
}

/** One cell of a grid drawn on an image, in that image's CSS pixels. */
export interface Cell {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
}
/** The columns and rows a `tap_at` is scored on: at most ten each, one score level per column and row. */
export interface Grid {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Taps a viewport point; resolves to what the engine reported. */
  tapAt(point: { readonly x: number; readonly y: number }): Promise<string | undefined>;
}

export interface ActionSpace {
  readonly elements: readonly Element[];
  /** Per operation: target key -> bound target. Only operations with at least one target appear. */
  readonly targets: ReadonlyMap<Operation, ReadonlyMap<string, Target>>;
  readonly controls: ReadonlyMap<Control, Target>;
  /** Where a `drag` can drop, by element key; empty when nothing can receive a drop. */
  readonly destinations: ReadonlyMap<string, Destination>;
  /** The `tap_at` columns and rows; absent without a screenshot, the `tapAt` verb, or a model that scores. */
  readonly grid?: Grid;
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
/**
 * Columns and rows of the `tap_at` grid: the Decisions API scores at most ten
 * levels per question. A 1280 by 720 viewport gets 10 columns of 128px and
 * 9 rows of 80px. Measured on gpt-6-luna over the drawn keypad, the
 * probability-weighted column and row land within 45px of every key.
 */
const MAX_LEVELS = 10;
const CELL_TARGET = 80;

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
/** Live regions whose text reports what the app just did. */
const liveRegions = new Set(['status', 'alert', 'log']);
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
  /** Granted pixels; with the `tapAt` verb and a scoring model they open the `tap_at` grid. */
  readonly pixels?: ExecutorPixels;
  /** Whether the decision model answers score questions, which locate a `tap_at`. */
  readonly scores?: boolean;
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
      if (verbs.has('tap') && tappable.has(role) && !checkable.has(role) && !(role === 'option' && childSelect) && !fileInput) {
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
      // Paths come from the text model, as typed values do.
      if (verbs.has('upload') && fileInput && canType) operations.push('upload');
      const interactive = operations.length > 0;
      const pressable = tappable.has(role) && !checkable.has(role) && !(role === 'option' && childSelect) && !fileInput;
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
        if (liveRegions.has(role)) {
          const text = (node.text ?? '').replace(/\s+/g, ' ').trim();
          if (text !== '') statuses.push(`${(node.name ?? '').trim() || role}: ${text}`);
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
  const targets = new Map<Operation, Map<string, Target>>();
  const destinations = new Map<string, Destination>();
  let selectCount = 0;
  const elements: Element[] = kept.map((row, position) => {
    const index = String(position + 1);
    const label = clip(nodeLabel(row.node), 120);
    const role = row.node.role ?? '';
    if (verbs.has('drag') && droppable.has(role) && label !== '') {
      destinations.set(index, { id: row.node.id, label, role });
    }
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
            run: () => quiet(ctx.actions.select({ id: row.node.id }, optionLabel)),
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
        const target: Target = bind(row.node, operation, label, ctx, destinations);
        const group = targets.get(operation) ?? new Map<string, Target>();
        group.set(key, target);
        targets.set(operation, group);
      }
    }
    return {
      index,
      role,
      label,
      ...(row.node.value === undefined ? {} : { value: row.node.value }),
      ...(row.node.states?.checked === undefined ? {} : { checked: row.node.states.checked }),
      ...(row.node.states?.expanded === undefined ? {} : { expanded: row.node.states.expanded }),
      operations: row.operations,
    };
  });
  // A drag with nowhere to drop is no operation.
  if (destinations.size === 0) {
    targets.delete('drag');
    for (const [position, element] of elements.entries()) {
      if (element.operations.includes('drag')) {
        elements[position] = { ...element, operations: element.operations.filter((operation) => operation !== 'drag') };
      }
    }
  }
  let grid: Grid | undefined;
  if (observation.pixels !== undefined && observation.scores === true && verbs.has('tapAt')) {
    const { width, height } = observation.viewport;
    const columns = Math.min(MAX_LEVELS, Math.max(1, Math.round(width / CELL_TARGET)));
    const lines = Math.min(MAX_LEVELS, Math.max(1, Math.round(height / CELL_TARGET)));
    const cellWidth = width / columns;
    const cellHeight = height / lines;
    // The engine's prose for a bare point ("no listed control is there")
    // reads as a miss to a classifier; whether the page changed says more.
    grid = {
      columns,
      rows: lines,
      cellWidth,
      cellHeight,
      tapAt: async (point) => {
        const result = await ctx.actions.tapAt(point);
        return result.target === undefined ? undefined : `landed on listed control ${result.target.id}`;
      },
    };
  }
  const controls = new Map<Control, Target>();
  if (verbs.has('scroll')) {
    controls.set('scroll_up', { description: 'scroll viewport up', run: () => quiet(ctx.actions.scroll('up')) });
    controls.set('scroll_down', { description: 'scroll viewport down', run: () => quiet(ctx.actions.scroll('down')) });
  }
  if (verbs.has('back')) {
    controls.set('back', { description: 'back one step in history', run: () => quiet(ctx.actions.back()) });
  }
  return {
    elements,
    targets,
    controls,
    destinations,
    ...(grid === undefined ? {} : { grid }),
    omitted,
    pageText: clip(pageText.join('\n'), 6000),
    statuses: statuses.slice(0, 20),
    fingerprint: fingerprint(observation.path ?? '', observation.tree, observation.viewport, observation.pixels),
  };
}

/** Binds one element operation to the runner's actions. */
function bind(
  node: ExecutorNode,
  operation: Operation,
  label: string,
  ctx: StepExecutorContext,
  destinations: ReadonlyMap<string, Destination>,
): Target {
  const target = { id: node.id };
  const where = `${label} [${node.id}]`;
  switch (operation) {
    case 'tap':
      return { description: `tap ${where}`, run: () => quiet(ctx.actions.tap(target)) };
    case 'type':
      return { description: `type into ${where}`, run: (argument = '') => quiet(ctx.actions.type(target, argumentText(argument))) };
    case 'typeSecret':
      return { description: `typeSecret into ${where}`, run: (argument = '') => quiet(ctx.actions.typeSecret(target, argumentText(argument))) };
    case 'submit':
      return { description: `submit ${where}`, run: () => quiet(ctx.actions.press(target, 'Enter')) };
    case 'check':
      return { description: `check ${where}`, run: () => quiet(ctx.actions.check(target, !(node.states?.checked ?? false))) };
    case 'hover':
      return { description: `hover ${where}`, run: () => quiet(ctx.actions.hover(target)) };
    case 'secondary_tap':
      return { description: `right-click ${where}`, run: () => quiet(ctx.actions.secondaryTap(target)) };
    case 'double_tap':
      return { description: `double-tap ${where}`, run: () => quiet(ctx.actions.doubleTap(target)) };
    case 'long_press':
      return { description: `long-press ${where}`, run: () => quiet(ctx.actions.longPress(target)) };
    case 'scroll_to':
      return { description: `scroll to ${where}`, run: () => quiet(ctx.actions.scrollTo(target)) };
    case 'upload':
      return {
        description: `upload to ${where}`,
        run: (argument = []) => quiet(ctx.actions.upload(target, typeof argument === 'string' ? [argument] : argument)),
      };
    case 'drag':
      return {
        description: `drag ${where}`,
        run: (argument = '') => {
          const destination = destinations.get(argumentText(argument));
          if (destination === undefined) throw new Error('drag needs a destination key');
          return quiet(ctx.actions.drag(target, { id: destination.id }));
        },
      };
    case 'select':
    case 'tap_at':
      throw new Error(`${operation} binds elsewhere`);
  }
}

/** An action with nothing to report back. */
async function quiet(action: Promise<void>): Promise<undefined> {
  await action;
  return undefined;
}
/** The string form of a run argument; a path list joins with commas. */
function argumentText(argument: string | readonly string[]): string {
  return typeof argument === 'string' ? argument : argument.join(',');
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
  let hash = 2166136261;
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  if (pixels !== undefined) {
    for (const byte of pixels.data) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    feed('\0');
  }
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
    feed(intersects(node, viewport) ? 'v' : '-');
    feed('\0');
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return (hash >>> 0).toString(36);
}
