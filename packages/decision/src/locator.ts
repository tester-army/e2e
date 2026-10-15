import type { StepExecutorContext } from 'e2e';
import type { Decision } from './decide.ts';
import { CELL_TARGET, gridFor, pointOf, regionHash, withGrid, zoomAround, type Grid, type Point, type Screenshot } from './overlay.ts';
import { describe, gated, invalid, need, type Gates } from './picks.ts';
import { pointRequest, type DecisionRequest } from './questions.ts';
/** Asks the decision model one request, or nothing once the step budget is spent. */
export type AskDecision = (request: DecisionRequest) => Promise<Record<string, Decision> | undefined>;
/** What a point look is after: a control to tap, or a field to type into. */
export type Aim = 'control' | 'field';
/** Where a drawn control is, or why the looks could not say. */
export type Located = Point | { readonly uncertain: string };
/**
 * CSS pixels of the regions the zoomed looks enlarge, in turn: the first
 * wide enough to hold a first look one column off, the second for a target
 * as small as a 32px map pin. Measured on Jev over 54 drawn targets at the
 * runner's 768px capture, the second zoom lifts hits from 47-49 to 53-54.
 */
const ZOOM_BOXES = [400, 200] as const;
/**
 * The zoomed looks per aim. A field is wide enough for the full screenshot
 * alone; a crop around it also holds its neighbors, and measured on Jev over
 * a drawn form the zooms split their mass between two stacked fields and
 * landed between them (about 4 in 5 hit), where the first look hit 72 of 72.
 */
const LOOKS: Readonly<Record<Aim, readonly number[]>> = { control: ZOOM_BOXES, field: [] };
/** How much each zoomed region is enlarged. */
const ZOOM_FACTOR = 2;
/** Columns and rows of the grid drawn on a zoomed region. */
const ZOOM_CELLS = 8;
/**
 * Locates drawn controls on the screenshot and remembers the ones a tap
 * found: three looks per control, the column and row on the plain full
 * screenshot, then again on two ever tighter zoomed crops with a grid drawn
 * on them; a field takes the first look alone. A tap that changed the pixels around it found its control; the
 * same control on the same page is tapped there again with no new looks.
 */
export class PointLocator {
  /** Points that landed, by path and the control the text model named. */
  private readonly landed = new Map<string, Point>();
  /** The last point tap, settled against the next observation. */
  private pending: { readonly key: string; readonly point: Point; readonly before: string | undefined } | undefined;
  constructor(
    private readonly ctx: StepExecutorContext,
    private readonly ask: AskDecision,
    private readonly gates: Gates,
  ) {}
  /** A point already known for this control on this page. */
  known(path: string, wanted: string, aim: Aim): Point | undefined {
    return this.landed.get(key(path, wanted, aim));
  }
  /** Records a point tap, to be settled by the next observation. */
  tapped(path: string, wanted: string, aim: Aim, point: Point, screenshot: Screenshot): void {
    this.pending = { key: key(path, wanted, aim), point, before: regionHash(screenshot, point, ZOOM_BOXES[0]) };
  }
  /** Settles the last point tap against the newest pixels: changed means it landed. */
  settle(screenshot: Screenshot | undefined): void {
    if (this.pending === undefined) return;
    const after = regionHash(screenshot, this.pending.point, ZOOM_BOXES[0]);
    if (after !== undefined && after !== this.pending.before) this.landed.set(this.pending.key, this.pending.point);
    else this.landed.delete(this.pending.key);
    this.pending = undefined;
  }
  /** The looks for the control or field, or undefined once the budget is spent. */
  async locate(screenshot: Screenshot, path: string, wanted: string, aim: Aim): Promise<Located | undefined> {
    const grid = gridFor(screenshot.width / screenshot.scale, screenshot.height / screenshot.scale, CELL_TARGET);
    const coarse = await this.ask(pointRequest(this.ctx, path, screenshot, grid, 'This image is the full screenshot; no grid is drawn on it.', wanted));
    if (coarse === undefined) return undefined;
    const first = this.scored(coarse);
    if ('uncertain' in first) return first;
    let point = pointOf(grid, first.x, first.y);
    for (const box of LOOKS[aim]) {
      const closer = await this.closer(screenshot, path, wanted, aim, point, box);
      if (closer === undefined || 'uncertain' in closer) return closer;
      point = closer;
    }
    return point;
  }
  /** One zoomed look: the `box` CSS-pixel region around `point`, enlarged with a grid drawn on it. */
  private async closer(screenshot: Screenshot, path: string, wanted: string, aim: Aim, point: Point, box: number): Promise<Located | undefined> {
    const zoom = zoomAround(screenshot, point, box, ZOOM_FACTOR);
    if (zoom === undefined) return point;
    const side = zoom.screenshot.width;
    const fine: Grid = { columns: ZOOM_CELLS, rows: ZOOM_CELLS, cellWidth: side / ZOOM_CELLS, cellHeight: side / ZOOM_CELLS };
    const region = Math.round(side / ZOOM_FACTOR);
    const framing = `This image is a ${ZOOM_FACTOR}x zoom of a ${region} by ${region} pixel region of the screen.`;
    const answers = await this.ask(pointRequest(this.ctx, path, withGrid(zoom.screenshot, fine), fine, framing, wanted));
    if (answers === undefined) return undefined;
    const scored = this.scored(answers);
    if ('uncertain' in scored) return scored;
    const inZoom = pointOf(fine, scored.x, scored.y);
    return { x: Math.round(zoom.origin.x + inZoom.x / zoom.factor), y: Math.round(zoom.origin.y + inZoom.y / zoom.factor) };
  }
  /** The column and row scores of a point request, gated like any answer. */
  private scored(answers: Record<string, Decision>): Point | { uncertain: string } {
    const x = need(answers.x, 'x');
    const y = need(answers.y, 'y');
    if (x.score === undefined || y.score === undefined) throw invalid('The decision model answered a point question without a score.');
    if (!gated(x, this.gates) || !gated(y, this.gates)) return { uncertain: `x ${describe(x)}; y ${describe(y)}` };
    return { x: x.score, y: y.score };
  }
}
/** A landed point's key: a field and a control the text model named alike are located apart. */
function key(path: string, wanted: string, aim: Aim): string {
  return `${path}\0${aim}\0${wanted}`;
}
