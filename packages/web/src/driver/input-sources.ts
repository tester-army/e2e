/** Typed text and pointer gestures as WebDriver BiDi `input.performActions` sources. */

import type { Input } from 'webdriver-bidi-protocol';
import type { KeyModifier, Momentum, ScrollDirection, ViewportPoint } from 'e2e/engine';
import { KEYS, keyValue, modifierValue } from './keyboard.ts';

/** Enter's WebDriver value, which a typed newline presses. */
const ENTER = keyValue(KEYS.get('Enter')!, false)!;

/** The key source that types `text` one grapheme at a time, as a person would; a newline is Enter. */
export function typeSource(text: string): Input.KeySourceActions {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const actions: Input.KeySourceAction[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const value = segment === '\n' || segment === '\r\n' ? ENTER : segment;
    actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
  }
  return { type: 'key', id: 'keyboard', actions };
}

/** Pointer button numbers: the primary and the secondary (context-menu) button. */
export type PointerButton = 0 | 2;

/** How a click presses: which button, how many times, how long, with which modifiers held. */
export interface ClickOptions {
  readonly button?: PointerButton;
  readonly clicks?: number;
  /** How long each press is held before release. */
  readonly holdMs?: number;
  readonly modifiers?: readonly KeyModifier[];
}

/**
 * The sources of a click at a viewport point: a mouse move, then each press
 * and release, with any modifiers held on a key source across the same ticks.
 */
export function clickSources(x: number, y: number, options: ClickOptions = {}): Input.SourceActions[] {
  const button = options.button ?? 0;
  const pointer: Input.PointerSourceAction[] = [{ type: 'pointerMove', x, y, origin: 'viewport' }];
  for (let click = 0; click < (options.clicks ?? 1); click += 1) {
    pointer.push({ type: 'pointerDown', button });
    if (options.holdMs !== undefined) pointer.push({ type: 'pause', duration: options.holdMs });
    pointer.push({ type: 'pointerUp', button });
  }
  return withModifiers(mouse(pointer), options.modifiers ?? []);
}

/** The source that moves the mouse to a viewport point. */
export function moveSources(x: number, y: number): Input.SourceActions[] {
  return [mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }])];
}

/** The source that presses the primary button at a viewport point and holds it (`mouse.down`). */
export function pressDownSources(x: number, y: number): Input.SourceActions[] {
  return [mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }])];
}

/** The source that releases the primary button where the mouse is (`mouse.up`). */
export function releaseSources(): Input.SourceActions[] {
  return [mouse([{ type: 'pointerUp', button: 0 }])];
}

/** Steps a drag moves through between its press and its release, so drag-and-drop libraries see motion. */
const DRAG_STEPS = 5;

/** A drag's points: its start, then each step to `to`. */
export function dragPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const path = [{ x: from.x, y: from.y }];
  for (let index = 1; index <= DRAG_STEPS; index += 1) {
    path.push({
      x: Math.round(from.x + ((to.x - from.x) * index) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * index) / DRAG_STEPS),
    });
  }
  return path;
}

/** How long each step of a drag that lasts `durationMs` takes. */
export function dragStepMs(durationMs: number): number {
  return Math.round(durationMs / DRAG_STEPS);
}

/** The pointer moves through `points`, each taking `stepMs`. */
export function moveActions(points: readonly { x: number; y: number }[], stepMs: number): Input.PointerSourceAction[] {
  return points.map((point) => ({ type: 'pointerMove' as const, x: point.x, y: point.y, origin: 'viewport' as const, ...(stepMs > 0 ? { duration: stepMs } : {}) }));
}

/** The source of one wheel gesture at a viewport point. */
export function wheelSources(x: number, y: number, deltaX: number, deltaY: number): Input.SourceActions[] {
  return [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x, y, deltaX, deltaY, origin: 'viewport' }] }];
}

/** The sources of a swipe at a viewport point: the mouse moves there, so what it scrolls is hovered as a person's would be, then the wheel turns. */
export function swipeSources(x: number, y: number, deltaX: number, deltaY: number): Input.SourceActions[] {
  return [
    mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }, { type: 'pause' }]),
    { type: 'wheel', id: 'wheel', actions: [{ type: 'pause' }, { type: 'scroll', x, y, deltaX, deltaY, origin: 'viewport' }] },
  ];
}

/** The one mouse pointer source every pointer action of the driver goes through. */
export function mouse(actions: Input.PointerSourceAction[]): Input.PointerSourceActions {
  return { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions };
}

/**
 * Holds `modifiers` for the whole pointer sequence: the key source presses
 * them on the first ticks, pauses while the pointer acts, and releases them
 * after it.
 */
function withModifiers(pointer: Input.PointerSourceActions, modifiers: readonly KeyModifier[]): Input.SourceActions[] {
  if (modifiers.length === 0) return [pointer];
  const codes = modifiers.map(modifierValue);
  const keys: Input.KeySourceAction[] = [
    ...codes.map((value) => ({ type: 'keyDown' as const, value })),
    ...pointer.actions.map(() => ({ type: 'pause' as const })),
    ...codes.map((value) => ({ type: 'keyUp' as const, value })),
  ];
  const lead: Input.PointerSourceAction[] = codes.map(() => ({ type: 'pause' }));
  return [{ type: 'key', id: 'keyboard', actions: keys }, { ...pointer, actions: [...lead, ...pointer.actions] }];
}

/**
 * The browser truncates a fractional pointer coordinate, so a point composed
 * from a fractional box (`tap({ position })` on a node at y 148.875) would
 * land on the pixel before the one asked for; it is rounded to the nearest
 * CSS pixel instead.
 */
export function nearestPixel(point: ViewportPoint): ViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/** How far one swipe scrolls across an `extent` of CSS pixels at `momentum`. */
export function swipeDistance(extent: number, momentum: Momentum): number {
  const ratio = momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5;
  return Math.round(extent * ratio);
}

/** The wheel deltas that scroll `distance` pixels toward `direction`. */
export function wheelDelta(direction: ScrollDirection, distance: number): [number, number] {
  switch (direction) {
    case 'down':
      return [0, distance];
    case 'up':
      return [0, -distance];
    case 'right':
      return [distance, 0];
    case 'left':
      return [-distance, 0];
  }
}
