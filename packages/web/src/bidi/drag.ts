/**
 * Pointer drags on Chromium, as Playwright's Chromium driver performs them.
 * A drag the page starts (an HTML5 `draggable` picked up) is intercepted
 * through CDP (`Input.setInterceptDrags`, reached with the mapper's
 * `goog:cdp` passthrough), and its enter, over, and drop are dispatched with
 * the drag data the page set (`Input.dispatchDragEvent`): a synthesized
 * mouse drag in headless Chromium drops without its `dataTransfer`. A drag
 * the page does not start stays plain pointer moves.
 */

import type { BidiConnection } from './connection.ts';
import { raceAbort } from 'e2e/engine';
import { releaseQuietly, unlessStale } from './errors.ts';
import { mouse } from './input.ts';
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
 * Presses at the path's first point, moves through the rest, and releases
 * at the last; a drag the page starts on the first move carries its data to
 * the drop. `stepMs` paces each move. Once `signal` aborts, nothing more is
 * dispatched; however it ends, interception is off and the button is up
 * where the mouse last was, so a drag that failed midway drops nothing at
 * the target, and only the mouse is released, so keys the test holds stay
 * held.
 */
export async function chromiumDrag(
  connection: BidiConnection,
  context: string,
  documents: readonly string[],
  path: readonly Point[],
  stepMs: number,
  signal: AbortSignal,
): Promise<void> {
  const [from, first, ...rest] = path;
  if (from === undefined || first === undefined) return;
  const last = rest.at(-1) ?? first;
  const { session } = (await connection.sendExtension('goog:cdp.getSession', { context })) as { session: string };
  const cdp = (method: string, params: object): Promise<unknown> => {
    signal.throwIfAborted();
    return connection.sendExtension('goog:cdp.sendCommand', { method, params, session });
  };
  const pointer = (actions: Parameters<typeof mouse>[0]): Promise<unknown> => {
    signal.throwIfAborted();
    return connection.send('input.performActions', { context, actions: [mouse(actions)] });
  };
  let intercepted: (data: unknown) => void = () => undefined;
  const dragData = new Promise<unknown>((resolve) => (intercepted = resolve));
  const off = connection.onExtension('goog:cdp.Input.dragIntercepted', (event) => {
    if (event['session'] === session) intercepted((event['params'] as { data: unknown }).data);
  });
  let subscription: string | undefined;
  let pressed = false;
  let intercepting = false;
  try {
    subscription = await connection.subscribeExtension(['goog:cdp.Input.dragIntercepted'], [context]);
    signal.throwIfAborted();
    pressed = true;
    await pointer([{ type: 'pointerMove', x: from.x, y: from.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }]);
    // Armed after the press: armed before, it latches onto the move to the press point and misses the drag.
    await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, watchDrag), undefined)));
    intercepting = true;
    await cdp('Input.setInterceptDrags', { enabled: true });
    // One discrete move, as Playwright's: an interpolated one would be checked before it passed the drag threshold.
    await pointer([{ type: 'pointerMove', x: first.x, y: first.y, origin: 'viewport' }]);
    const started = await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, dragStarted, [], { awaitPromise: true }), false)));
    const data = started.includes(true) ? await raceAbort(dragData, signal, 'drag') : undefined;
    await cdp('Input.setInterceptDrags', { enabled: false });
    intercepting = false;
    if (data === undefined) {
      await pointer([
        ...rest.map((point) => ({ type: 'pointerMove' as const, x: point.x, y: point.y, origin: 'viewport' as const, ...(stepMs > 0 ? { duration: stepMs } : {}) })),
        { type: 'pointerUp', button: 0 },
      ]);
      pressed = false;
      return;
    }
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: first.x, y: first.y, data });
    for (const point of rest) await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data });
    await cdp('Input.dispatchDragEvent', { type: 'drop', x: last.x, y: last.y, data });
  } finally {
    off();
    if (intercepting) await releaseQuietly(connection.sendExtension('goog:cdp.sendCommand', { method: 'Input.setInterceptDrags', params: { enabled: false }, session }));
    if (pressed) await releaseQuietly(connection.send('input.performActions', { context, actions: [mouse([{ type: 'pointerUp', button: 0 }])] }));
    if (subscription !== undefined) await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
  }
}
