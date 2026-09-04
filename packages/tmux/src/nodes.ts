/**
 * Projection of one pane capture onto the contract's `SemanticNode` tree.
 * The terminal grid has no widgets to discover, so the tree is honest about
 * what a terminal is: one `application` root sized to the pane, and one
 * `text` node per printed segment. A row is split into segments at runs of
 * two or more spaces, because that gap is how TUIs draw columns (`/help
 * Help`, `[ Yes ]   [ No ]`): each column is then its own node with its own
 * cell rect, so `getByText('/help')` matches the command and a tap lands on
 * the right button. A row with several segments is wrapped in a nameless
 * `row` so the columns stay associated; a row with one is that node alone.
 * The segment under a visible cursor is a focused `textbox` - the one place
 * keyboard input lands. Rects are in cells: `y` is the row, `x` the column.
 */

import type { SemanticNode } from '@e2edev/e2e/backend';
import type { ScreenCapture } from './screen.ts';

/** One projected node with the cell geometry actions need. */
export interface ProjectedNode {
  readonly id: string;
  readonly node: SemanticNode;
  /** Row of a segment or row node; undefined for the root and the exit status. */
  readonly row?: number;
  readonly parent?: ProjectedNode;
}

export interface ProjectedScreen {
  readonly root: SemanticNode;
  /** Every node in document order, root first. */
  readonly index: readonly ProjectedNode[];
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
}

interface Segment {
  readonly x: number;
  readonly text: string;
}

/** Runs of printed cells separated by single spaces; two spaces or more end a segment. */
const SEGMENT_PATTERN = /\S+(?: \S+)*/g;
/** Segments that are pure decoration: box drawing, block elements, and ASCII rulers or borders. */
const DECORATION_PATTERN = /^[─-▟|+\-=_#*~:.]+$/;

/**
 * The printed segments of one row, decoration dropped, in column order. A
 * border glyph one space away from text (`┃ /help`) is decoration too, so
 * decoration words are peeled off both ends of a segment; one inside a
 * sentence (`a - b`) is kept.
 */
export function segmentsOf(line: string): Segment[] {
  const segments: Segment[] = [];
  for (const match of line.matchAll(SEGMENT_PATTERN)) {
    const words = match[0].split(' ');
    let x = match.index;
    while (words.length > 0 && DECORATION_PATTERN.test(words[0] as string)) {
      x += (words.shift() as string).length + 1;
    }
    while (words.length > 0 && DECORATION_PATTERN.test(words.at(-1) as string)) words.pop();
    if (words.length === 0) continue;
    segments.push({ x, text: words.join(' ') });
  }
  return segments;
}

/**
 * The segment the cursor is in: the one whose cells include the cursor
 * column (the cell right after the last character counts, where a cursor
 * rests after typing), else the nearest one to its left, else the first.
 */
function cursorSegment(segments: readonly Segment[], column: number): number {
  let nearest = -1;
  for (const [position, segment] of segments.entries()) {
    if (column >= segment.x && column <= segment.x + segment.text.length) return position;
    if (segment.x < column) nearest = position;
  }
  return nearest === -1 ? 0 : nearest;
}

/**
 * Projects one capture. `mintId` is called once per node in document order,
 * so the surface's id space stays unique across observations.
 */
export function projectScreen(screen: ScreenCapture, mintId: () => string): ProjectedScreen {
  const index: ProjectedNode[] = [];
  const rootId = mintId();
  const rootHolder: { node: SemanticNode | undefined } = { node: undefined };
  const root: ProjectedNode = {
    id: rootId,
    get node(): SemanticNode {
      return rootHolder.node as SemanticNode;
    },
  };
  index.push(root);

  const children: SemanticNode[] = [];
  screen.lines.forEach((line, row) => {
    const segments = segmentsOf(line);
    const atCursor = screen.cursor.visible && screen.cursor.y === row;
    if (segments.length === 0) {
      if (!atCursor) return;
      // A blank row under the cursor is still where typing lands: an empty textbox at the cursor cell.
      const id = mintId();
      const node: SemanticNode = {
        ref: { id, revision: '' },
        role: 'textbox',
        states: { focused: true },
        rect: { x: screen.cursor.x, y: row, width: 1, height: 1 },
      };
      index.push({ id, node, row, parent: root });
      children.push(node);
      return;
    }
    const focused = atCursor ? cursorSegment(segments, screen.cursor.x) : -1;
    const wrap = segments.length > 1;
    const rowHolder: { node: SemanticNode | undefined } = { node: undefined };
    const rowEntry: ProjectedNode | undefined = wrap
      ? {
          id: mintId(),
          row,
          parent: root,
          get node(): SemanticNode {
            return rowHolder.node as SemanticNode;
          },
        }
      : undefined;
    if (rowEntry !== undefined) index.push(rowEntry);
    const cells = segments.map((segment, position) => {
      const id = mintId();
      const node: SemanticNode = {
        ref: { id, revision: '' },
        role: position === focused ? 'textbox' : 'text',
        name: segment.text,
        text: segment.text,
        ...(position === focused ? { states: { focused: true } } : {}),
        rect: { x: segment.x, y: row, width: segment.text.length, height: 1 },
      };
      index.push({ id, node, row, parent: rowEntry ?? root });
      return node;
    });
    if (rowEntry === undefined) {
      children.push(cells[0] as SemanticNode);
      return;
    }
    const first = segments[0] as Segment;
    const last = segments.at(-1) as Segment;
    rowHolder.node = {
      ref: { id: rowEntry.id, revision: '' },
      role: 'row',
      rect: { x: first.x, y: row, width: last.x + last.text.length - first.x, height: 1 },
      children: cells,
    };
    children.push(rowHolder.node);
  });

  if (screen.dead) {
    const id = mintId();
    const status = screen.exitStatus === undefined ? 'the program exited' : `the program exited with status ${screen.exitStatus}`;
    const node: SemanticNode = { ref: { id, revision: '' }, role: 'status', name: status, text: status };
    index.push({ id, node, parent: root });
    children.push(node);
  }

  const title = screen.title.trim() === '' ? screen.command : screen.title;
  rootHolder.node = {
    ref: { id: rootId, revision: '' },
    role: 'application',
    ...(title === '' ? {} : { name: title }),
    ...(screen.dead ? { states: { disabled: true } } : {}),
    rect: { x: 0, y: 0, width: screen.width, height: screen.height },
    ...(children.length === 0 ? {} : { children }),
  };
  return { root: rootHolder.node, index, viewport: { width: screen.width, height: screen.height, scale: 1 } };
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: ProjectedNode, ancestor: ProjectedNode): boolean {
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}
