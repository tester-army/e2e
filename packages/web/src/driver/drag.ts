/**
 * Pointer drags on Chromium, as Playwright's Chromium driver performs them.
 * A drag the page starts (an HTML5 `draggable` picked up) is intercepted
 * through CDP (`Input.setInterceptDrags`, reached with the mapper's
 * `goog:cdp` passthrough), and its enter, over, and drop are dispatched with
 * the drag data the page set (`Input.dispatchDragEvent`): a synthesized
 * mouse drag in headless Chromium drops without its `dataTransfer`. A drag
 * the page does not start stays plain pointer moves.
 */

import type { Protocol } from 'devtools-protocol';
import { raceAbort } from 'e2e/engine';
import type { BidiInput } from './input.ts';
import { releaseQuietly, unlessStale } from '../errors.ts';
import { dragPath, mouse, moveActions } from './input-sources.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction } from './script.ts';

type Point = { readonly x: number; readonly y: number };

/** Records, in the page, whether the next mouse move started a drag the page did not cancel. */
function watchDrag(): void {
  let started = Promise.resolve(false);
  let drag: DragEvent | null = null;
  const onDrag = (event: DragEvent): void => {
    drag = event;
  };
  const onMove = (): void => {
    started = new Promise((resolve) => {
      window.addEventListener('dragstart', onDrag, { once: true, capture: true });
      setTimeout(() => resolve(drag !== null && !drag.defaultPrevented), 0);
    });
  };
  window.addEventListener('mousemove', onMove, { once: true, capture: true });
  Reflect.set(window, Symbol.for('e2e.drag'), async () => {
    const value = await started;
    window.removeEventListener('mousemove', onMove, { capture: true });
    window.removeEventListener('dragstart', onDrag, { capture: true });
    return value;
  });
}

/** Whether the move `watchDrag` watched started a drag. */
function dragStarted(): Promise<boolean> | boolean {
  const check = Reflect.get(window, Symbol.for('e2e.drag')) as (() => Promise<boolean>) | undefined;
  return check === undefined ? false : check();
}

/**
 * Presses at `from`, then reads where the drag goes (`resolveTarget`), as
 * Playwright resolves a drop target only once the source is pressed, moves
 * there through `dragPath`, and releases; a drag the page starts on the
 * first move carries its data to the drop. `stepMs` paces each move. Every
 * input goes through `input`, the scripts and the drag event subscription
 * through `connection`. Once `signal` aborts, nothing more is dispatched;
 * however it ends, interception is off and the button is up where the
 * mouse last was, so a drag that failed midway drops nothing at the
 * target, and only the mouse is released, so keys the test holds stay
 * held.
 */
export async function chromiumDrag(
  input: BidiInput,
  connection: BidiConnection,
  context: string,
  documents: readonly string[],
  from: Point,
  resolveTarget: () => Promise<Point>,
  stepMs: number,
  signal: AbortSignal,
): Promise<void> {
  let intercepted: (data: Protocol.Input.DragData) => void = () => undefined;
  const dragData = new Promise<Protocol.Input.DragData>((resolve) => (intercepted = resolve));
  const off = await input.onDragIntercepted((data) => intercepted(data));
  let subscription: string | undefined;
  let pressed = false;
  let intercepting = false;
  try {
    subscription = await connection.subscribeExtension(['goog:cdp.Input.dragIntercepted'], [context]);
    signal.throwIfAborted();
    pressed = true;
    await input.send([mouse([{ type: 'pointerMove', x: from.x, y: from.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }])], signal);
    const [, first, ...rest] = dragPath(from, await resolveTarget());
    const last = rest.at(-1) ?? first!;
    // Armed after the press: armed before, it latches onto the move to the press point and misses the drag.
    await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, watchDrag), undefined)));
    signal.throwIfAborted();
    intercepting = true;
    await input.interceptDrags(true);
    // One discrete move, as Playwright's: an interpolated one would be checked before it passed the drag threshold.
    await input.send([mouse(moveActions([first!], 0))], signal);
    const started = await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, dragStarted, [], { awaitPromise: true }), false)));
    const data = started.includes(true) ? await raceAbort(dragData, signal, 'drag') : undefined;
    signal.throwIfAborted();
    await input.interceptDrags(false);
    intercepting = false;
    if (data === undefined) {
      await input.send([mouse([...moveActions(rest, stepMs), { type: 'pointerUp', button: 0 }])], signal);
      pressed = false;
      return;
    }
    await input.dragEvent('dragEnter', first!, data, signal);
    for (const point of rest) await input.dragEvent('dragOver', point, data, signal);
    await input.dragEvent('drop', last, data, signal);
  } finally {
    off();
    if (intercepting) await releaseQuietly(input.interceptDrags(false));
    if (pressed) await releaseQuietly(input.send([mouse([{ type: 'pointerUp', button: 0 }])]));
    if (subscription !== undefined) await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
  }
}
