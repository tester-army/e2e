import type { StepExecutorContext } from 'e2e';
import type { Decision } from './decide.ts';
import { CELL_TARGET, gridFor, pointOf, regionHash, withGrid, zoomAround, type Grid, type Point, type Screenshot } from './overlay.ts';
import { describe, gated, invalid, need, type Gates } from './picks.ts';
import { pointRequest, type DecisionRequest } from './questions.ts';
/** Asks the decision model one request, or nothing once the step budget is spent. */
export type AskDecision = (request: DecisionRequest) => Promise<Record<string, Decision> | undefined>;
/** Where a drawn control is, or why the looks could not say. */
export type Located = Point | { readonly uncertain: string };
/**
 * CSS pixels of the region the second look zooms into, and how much it is
 * enlarged: wide enough to hold a first look one column off. A tighter
 * third look was measured to drift on the runner's 768px capture.
 */
const ZOOM_BOX = 400;
const ZOOM_FACTOR = 2;
/** Columns and rows of the grid drawn on the zoomed region. */
const ZOOM_CELLS = 8;
/**
 * Locates drawn controls on the screenshot and remembers the ones a tap
 * found: two looks per control, the column and row on the plain full
 * screenshot, then again on a zoomed crop with a grid drawn on it. A tap
 * that changed the pixels around it found its control; the same control on
 * the same page is tapped there again with no new looks.
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
  known(path: string, wanted: string): Point | undefined {
    return this.landed.get(key(path, wanted));
  }
  /** Records a point tap, to be settled by the next observation. */
  tapped(path: string, wanted: string, point: Point, screenshot: Screenshot): void {
    this.pending = { key: key(path, wanted), point, before: regionHash(screenshot, point, ZOOM_BOX) };
  }
  /** Settles the last point tap against the newest pixels: changed means it landed. */
  settle(screenshot: Screenshot | undefined): void {
    if (this.pending === undefined) return;
    const after = regionHash(screenshot, this.pending.point, ZOOM_BOX);
    if (after !== undefined && after !== this.pending.before) this.landed.set(this.pending.key, this.pending.point);
    else this.landed.delete(this.pending.key);
    this.pending = undefined;
  }
  /** Two looks for the control, or undefined once the budget is spent. */
  async locate(screenshot: Screenshot, path: string, wanted: string): Promise<Located | undefined> {
    const grid = gridFor(screenshot.width / screenshot.scale, screenshot.height / screenshot.scale, CELL_TARGET);
    const coarse = await this.ask(pointRequest(this.ctx, path, screenshot, grid, 'This image is the full screenshot; no grid is drawn on it.', wanted));
    if (coarse === undefined) return undefined;
    const first = this.scored(coarse);
    if ('uncertain' in first) return first;
    const rough = pointOf(grid, first.x, first.y);
    const zoom = zoomAround(screenshot, rough, ZOOM_BOX, ZOOM_FACTOR);
    if (zoom === undefined) return rough;
    const side = zoom.screenshot.width;
    const fine: Grid = { columns: ZOOM_CELLS, rows: ZOOM_CELLS, cellWidth: side / ZOOM_CELLS, cellHeight: side / ZOOM_CELLS };
    const region = Math.round(side / ZOOM_FACTOR);
    const framing = `This image is a ${ZOOM_FACTOR}x zoom of a ${region} by ${region} pixel region of the screen.`;
    const closer = await this.ask(pointRequest(this.ctx, path, withGrid(zoom.screenshot, fine), fine, framing, wanted));
    if (closer === undefined) return undefined;
    const second = this.scored(closer);
    if ('uncertain' in second) return second;
    const inZoom = pointOf(fine, second.x, second.y);
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
function key(path: string, wanted: string): string {
  return `${path}\0${wanted}`;
}
