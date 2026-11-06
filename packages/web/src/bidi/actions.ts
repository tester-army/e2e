/**
 * Actions on the BiDi driver: one locator action on a node, one pointer
 * action at a point, and keyboard input, each after the actionability
 * checks Playwright runs, with points placed in the top-level viewport.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Deadline,
  EngineError,
  TestError,
  type LocatorAction,
  type NodeRef,
  type PointerAction,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { SECURE_FIELD_SELECTOR } from '../read-node.ts';
import { ROOT_NODE_ID } from '../observation.ts';
import { focusTakesKeys } from '../focus.ts';
import { nearestPixel, swipeDistance, wheelDelta } from '../support.ts';
import { chromiumDrag } from './drag.ts';
import { unlessStale } from './errors.ts';
import type { NodeTarget } from './frames.ts';
import { clickSources, dragPath, dragSources, dragStepMs, moveSources, typeSource, wheelSources, type ClickOptions } from './input.ts';
import { actionPoint as readActionPoint, armHitInterceptor, hitInterceptorResult, scrollIntoViewIfNeeded, boxSize, checkState, fileInput, fill as fillElement, focus, directoryInput, hitBlocker, insertFocusedText, nextFrame, selectOption, wheelAim, type ActionPoint } from './page.ts';
import { ElementRef } from './script.ts';
import type { BidiSession } from './session.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Pause between actionability checks of an element that is not ready yet. */
const POLL_MS = 50;
/** How a retry scrolls a covered element into view, as Playwright cycles them: as needed, then to the end, the centre, the start. */
const SCROLL_ALIGNMENTS = [
  undefined,
  { block: 'end', inline: 'end' },
  { block: 'center', inline: 'center' },
  { block: 'start', inline: 'start' },
] as const;
/** What the page's `fill` and `selectOption` refuse for now but may take once the app catches up, polled until the deadline. */
const NOT_YET = new Set(['element is not editable', 'element is not enabled', 'no option matches', 'option being selected is not enabled']);

/** One action on a located or observed node; a `swipe` on the observation root is the viewport swipe at the pointer. */
export async function perform(session: BidiSession, ref: NodeRef, action: LocatorAction, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
    await wheel(session, session.pointer, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    return;
  }
  const target = session.refs.lookup(ref);
  const deadline = new Deadline(timeoutMs);
  const held = 'modifiers' in action && action.modifiers !== undefined ? { modifiers: action.modifiers } : {};
  switch (action.kind) {
    case 'tap':
      return click(session, target, deadline, held, signal);
    case 'doubleTap':
      return click(session, target, deadline, { clicks: 2, ...held }, signal);
    case 'secondaryTap':
      return click(session, target, deadline, { button: 2, ...held }, signal);
    case 'longPress':
      return click(session, target, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }, signal);
    case 'hover': {
      const point = await pointerPoint(session, target, deadline, false, signal);
      return session.sendInput(moveSources(point.x, point.y), signal);
    }
    case 'fill':
      return fill(session, target, action.value, deadline, signal);
    case 'clear':
      return fill(session, target, '', deadline, signal);
    case 'press':
      await focusOn(session, target, signal);
      return session.pressKey(action.key, signal);
    case 'focus':
      return focusOn(session, target, signal);
    case 'scrollIntoView':
      return scrollIntoView(session, target, deadline, signal);
    case 'check':
    case 'uncheck':
      return setChecked(session, target, action.kind === 'check', deadline, signal);
    case 'selectOption': {
      const by = typeof action.value === 'string' ? { label: action.value } : action.value;
      await settledPoint(session, target, deadline, { enabled: true, scroll: false, pointer: false }, signal);
      return mutateWhenReady(session, deadline, signal, 'selectOption: ', () => session.run(selectOption, [target.element, by], target.context));
    }
    case 'setInputFiles':
      return setInputFiles(session, target, action.paths, deadline, signal);
    case 'dragTo':
      return dragTo(session, target, session.refs.lookup(action.target), deadline, signal);
    case 'swipe': {
      // A wheel the element already takes goes at once; only one something blocks waits for it to become actionable.
      const aimed = await session.run(wheelAim, [target.element], target.context);
      if (aimed.aim !== 'blocked') {
        const { box } = aimed;
        const at = aimed.aim === 'pointer' ? session.pointer : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return wheel(session, at, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
      }
      const point = await pointerPoint(session, target, deadline, false, signal);
      const box = await session.run(boxSize, [target.element], target.context);
      return wheel(session, point, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    }
  }
}

/** One pointer action at a viewport point with nothing resolved behind it. */
export async function performAt(session: BidiSession, point: ViewportPoint, action: PointerAction, signal: AbortSignal): Promise<void> {
  const at = nearestPixel(point);
  switch (action.kind) {
    case 'tap':
      return session.sendInput(clickSources(at.x, at.y), signal);
    case 'doubleTap':
      return session.sendInput(clickSources(at.x, at.y, { clicks: 2 }), signal);
    case 'secondaryTap':
      return session.sendInput(clickSources(at.x, at.y, { button: 2 }), signal);
    case 'longPress':
      return session.sendInput(clickSources(at.x, at.y, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }), signal);
    case 'hover':
      return session.sendInput(moveSources(at.x, at.y), signal);
    case 'dragTo':
      return drag(session, at, nearestPixel(action.target), 0, signal);
    case 'swipeTo':
      return drag(session, at, nearestPixel(action.target), action.durationMs ?? 0, signal);
    case 'swipe':
      return wheel(session, at, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
  }
}

/** Types into whatever holds focus, in any document of the tab, refusing when nothing there takes keystrokes. */
export async function typeText(session: BidiSession, text: string, replace: boolean, signal: AbortSignal): Promise<void> {
  const documents = await session.documentContexts(session.requireContext());
  const editable = await Promise.all(documents.map((context) =>
    unlessStale(session.call(focusTakesKeys.toString(), [CLOSED_SHADOW_ROOTS_KEY], undefined, context), false)));
  if (!editable.includes(true)) {
    throw new EngineError(
      'NOT_ACTIONABLE',
      'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
      { retryable: false },
    );
  }
  if (replace) {
    await session.pressKey('ControlOrMeta+a', signal);
    await session.pressKey('Delete', signal);
  }
  await typeInto(session, text, signal);
}

/**
 * Types `text` into whatever holds focus, as Playwright's `keyboard.type`
 * does: a character the US keyboard has is a key press, anything else (an
 * emoji, a letter of another alphabet) is inserted as text in the document
 * holding focus, since no key types it.
 */
export async function typeInto(session: BidiSession, text: string, signal: AbortSignal): Promise<void> {
  let run = '';
  const flush = async (): Promise<void> => {
    if (run === '') return;
    await session.sendInput([typeSource(run)], signal);
    run = '';
  };
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (/^[\x20-\x7e]$/.test(segment) || segment === '\n' || segment === '\r\n' || segment === '\t') {
      run += segment;
      continue;
    }
    await flush();
    signal.throwIfAborted();
    session.mutated();
    for (const context of await session.documentContexts(session.requireContext())) {
      if (await unlessStale(session.run(insertFocusedText, [segment], context), false)) break;
    }
  }
  await flush();
}

/**
 * Waits until the element can take a pointer action, then clicks it with
 * the page watching where the input lands (`armHitInterceptor`): input an
 * overlay raised as the pointer arrived is suppressed in the page before any
 * listener of the app sees it, counts as never dispatched, and the click is
 * tried again until the deadline. Input no event of the element's document
 * saw may have reached another document, so it is reported as may have
 * committed, never replayed. A page that went away under the click counts as
 * reached.
 */
async function click(session: BidiSession, target: NodeTarget, deadline: Deadline, options: ClickOptions, signal: AbortSignal): Promise<void> {
  for (;;) {
    const point = await pointerPoint(session, target, deadline, true, signal);
    await session.run(armHitInterceptor, [target.element], target.context);
    const dispatched = session.dispatches;
    const sent = await session.sendInput(clickSources(point.x, point.y, options), signal).then(() => undefined, (cause: unknown) => ({ cause }));
    const verdict = await unlessStale(session.run(hitInterceptorResult, [], target.context), null);
    if (sent !== undefined) throw sent.cause;
    if (verdict === null) return;
    if (verdict === 'unseen') {
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'the click reached no event in the element\'s document, so another document (an overlay in a parent frame) may have taken it', { retryable: false });
    }
    session.dispatches = dispatched;
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${verdict}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** Scrolls the element, and each frame holding it, into view as Playwright does, polling while it lays out no box or moves. */
async function scrollIntoView(session: BidiSession, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  for (const frame of session.frames.chain(target.context)) await session.run(scrollIntoViewIfNeeded, [frame.element], frame.context);
  for (;;) {
    signal.throwIfAborted();
    const state = await session.run(scrollIntoViewIfNeeded, [target.element], target.context);
    if (state === 'ok') return;
    if (state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${state === 'moving' ? 'element is not stable' : 'element is not visible'}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** Focuses the element, a page change its focus handlers may make; an element that takes no focus keeps the old one, as Playwright's `focus` leaves it. */
async function focusOn(session: BidiSession, target: NodeTarget, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  session.mutated();
  await session.run(focus, [target.element, CLOSED_SHADOW_ROOTS_KEY], target.context);
}

/**
 * Polls the element's actionability (`actionPoint`) until it is ready or the
 * deadline passes, each frame holding it settled into view first, and
 * returns the point in its own document's viewport.
 */
async function settledPoint(
  session: BidiSession,
  target: NodeTarget,
  deadline: Deadline,
  checks: { enabled: boolean; scroll: boolean; pointer?: boolean; align?: NonNullable<(typeof SCROLL_ALIGNMENTS)[number]> },
  signal: AbortSignal,
): Promise<{ x: number; y: number }> {
  if (checks.scroll) {
    for (const frame of session.frames.chain(target.context)) {
      await session.run(readActionPoint, [frame.element, { scroll: true, key: CLOSED_SHADOW_ROOTS_KEY }], frame.context);
    }
  }
  for (;;) {
    signal.throwIfAborted();
    const { enabled, ...placing } = checks;
    const disabled = enabled ? await session.reader('disabled', [target.element, readerOptions(session)], target.context) : false;
    const point: ActionPoint = disabled === null ? { state: 'detached' } : disabled ? { state: 'disabled' } : await session.run(readActionPoint, [target.element, { ...placing, key: CLOSED_SHADOW_ROOTS_KEY }], target.context);
    if (point.state === 'ok') return point;
    if (point.state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${blocker(point)}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * The element's actionable point in the top-level viewport, once a pointer
 * event there reaches it: the whole-pixel point to be dispatched is projected
 * back through every frame holding the element, and the element is hit at
 * that point in its document, every iframe at it in its parent's. A
 * covered element is polled until the deadline, each retry scrolling it into
 * view another way (`SCROLL_ALIGNMENTS`), as Playwright does to get an
 * element out from under a sticky header.
 */
async function pointerPoint(session: BidiSession, target: NodeTarget, deadline: Deadline, enabled: boolean, signal: AbortSignal): Promise<{ x: number; y: number }> {
  for (let retry = 0; ; retry += 1) {
    const align = SCROLL_ALIGNMENTS[retry % SCROLL_ALIGNMENTS.length];
    const local = await settledPoint(session, target, deadline, { enabled, scroll: true, ...(align === undefined ? {} : { align }) }, signal);
    const chain = session.frames.chain(target.context);
    const steps = await session.frames.frameSteps(session.connection, target.context);
    if (steps === null) throw new EngineError('NOT_ACTIONABLE', 'element is in a frame that lays out no box, or is rotated', { retryable: false });
    let point = { x: local.x, y: local.y };
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const { content, scale } = steps[index]!;
      point = { x: content.x + point.x * scale.x, y: content.y + point.y * scale.y };
    }
    const top = { x: Math.round(point.x), y: Math.round(point.y) };
    const inDocuments: { x: number; y: number }[] = [];
    let projected = top;
    for (const [index, { content, scale }] of steps.entries()) {
      inDocuments[index] = projected;
      projected = { x: (projected.x - content.x) / scale.x, y: (projected.y - content.y) / scale.y };
    }
    const checks = [
      session.run(hitBlocker, [target.element, projected.x, projected.y, CLOSED_SHADOW_ROOTS_KEY], target.context),
      ...chain.map((frame, index) => session.run(hitBlocker, [frame.element, inDocuments[index]!.x, inDocuments[index]!.y, CLOSED_SHADOW_ROOTS_KEY], frame.context)),
    ];
    const blocked = (await Promise.all(checks)).find((reason) => reason !== null);
    if (blocked === undefined) return top;
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${blocked}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** What the shared reader takes besides its mode. */
function readerOptions(session: BidiSession): { testIdAttribute: string; secureFieldSelector: string } {
  return { testIdAttribute: session.settings.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
}

/** What kept an element from being acted on, in Playwright's words. */
function blocker(point: Exclude<ActionPoint, { state: 'ok' }>): string {
  switch (point.state) {
    case 'moving':
      return 'element is not stable';
    case 'hidden':
      return 'element is not visible';
    case 'outside':
      return 'element is outside of the viewport';
    case 'disabled':
      return 'element is not enabled';
    case 'detached':
      return 'element is not attached to the DOM';
  }
}

/** Replaces the field's content with `value` in one edit, as a paste would, once it is visible, enabled, and editable (not still, nor in view: no pointer is involved); see the page's `fill`. */
async function fill(session: BidiSession, target: NodeTarget, value: string, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await settledPoint(session, target, deadline, { enabled: true, scroll: false, pointer: false }, signal);
  return mutateWhenReady(session, deadline, signal, '', () => session.run(fillElement, [target.element, value, CLOSED_SHADOW_ROOTS_KEY], target.context));
}

/**
 * Runs a page mutation that reports why it refused, polling while the
 * refusal is one the app may lift (`NOT_YET`): such a refusal changed
 * nothing, so it does not count as dispatched. Nothing runs once `signal`
 * aborted.
 */
async function mutateWhenReady(session: BidiSession, deadline: Deadline, signal: AbortSignal, prefix: string, mutate: () => Promise<string | null>): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const dispatched = session.dispatches;
    session.mutated();
    const problem = await mutate();
    if (problem === null) return;
    if (!NOT_YET.has(problem)) throw new EngineError('NOT_ACTIONABLE', `${prefix}${problem}`, { retryable: false });
    session.dispatches = dispatched;
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `${prefix}${problem}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Clicks a checkable once when its state differs, then polls until it
 * reads `checked`. A control gone after the click took it: the app replaced
 * it on change. A native radio cannot be cleared by a click; an ARIA radio is
 * clicked like any control, and its script decides what the click does.
 */
async function setChecked(session: BidiSession, target: NodeTarget, checked: boolean, deadline: Deadline, signal: AbortSignal): Promise<void> {
  const before = await session.run(checkState, [target.element], target.context);
  if (before.checked === null) throw new EngineError('NOT_ACTIONABLE', 'Not a checkbox or radio button', { retryable: false });
  if (before.checked === checked) return;
  if (!checked && before.radio === 'native') {
    throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
  }
  const hint = !checked && before.radio === 'aria' ? '; a radio usually clears only when another radio in its group is selected' : '';
  await click(session, target, deadline, {}, signal);
  for (let first = true; ; first = false) {
    const after = await unlessStale(session.run(checkState, [target.element], target.context), undefined);
    if (after === undefined) {
      if (first) return;
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change before the control was replaced`, { retryable: false });
    }
    if (after.checked === checked) return;
    if (deadline.remaining() <= POLL_MS) {
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change${hint}`, { retryable: false });
    }
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Whether `files` name one directory (else only files), refusing what
 * Playwright's upload refuses before it reaches the page: a path that does
 * not exist, more than one directory, and a directory beside files.
 */
async function uploadKind(files: readonly string[]): Promise<boolean> {
  const kinds = await Promise.all(files.map(async (file) => {
    try {
      return (await stat(file)).isDirectory();
    } catch (cause) {
      throw new TestError('INVALID_ARGUMENT', cause instanceof Error ? cause.message : String(cause));
    }
  }));
  const directories = kinds.filter(Boolean).length;
  if (directories > 1) throw new TestError('INVALID_ARGUMENT', 'Multiple directories are not supported');
  if (directories === 1 && files.length > 1) throw new TestError('INVALID_ARGUMENT', 'File paths must be all files or a single directory');
  return directories === 1;
}

/**
 * Attaches files to a file input or one a `<label>` names directly; any
 * other control is clicked with the file chooser awaited
 * (`input.fileDialogOpened`), and the input that chooser serves takes the
 * files. A control that opens no chooser by the deadline fails, as
 * Playwright's upload does. A browser on another machine is refused:
 * `input.setFiles` takes paths on the browser's own filesystem.
 */
async function setInputFiles(session: BidiSession, target: NodeTarget, paths: readonly string[], deadline: Deadline, signal: AbortSignal): Promise<void> {
  if (session.settings.remoteFiles) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'setInputFiles: local files cannot be sent to a browser provider\'s browser on another machine', { retryable: false });
  }
  const connection = session.connection;
  const files = paths.map((file) => path.resolve(session.settings.projectRoot, file));
  const directory = await uploadKind(files);
  const send = async (context: string, element: ElementRef): Promise<void> => {
    const takesDirectory = await session.run(directoryInput, [element], context);
    if (directory && !takesDirectory) throw new TestError('INVALID_ARGUMENT', 'File input does not support directories, pass individual files instead');
    if (!directory && takesDirectory) throw new TestError('INVALID_ARGUMENT', '[webkitdirectory] input requires passing a path to a directory');
    signal.throwIfAborted();
    session.mutated();
    await connection.send('input.setFiles', { context, element: { sharedId: element.sharedId }, files });
  };
  const input = await session.run(fileInput, [target.element], target.context);
  if (input instanceof ElementRef) {
    await send(target.context, input);
    return;
  }
  const timer = new AbortController();
  let off: () => void = () => undefined;
  const opened = new Promise<{ context: string; element?: { sharedId: string } } | undefined>((resolve) => {
    off = connection.on('input.fileDialogOpened', (info) => {
      if (session.onPage(info.context)) resolve(info);
    });
    timer.signal.addEventListener('abort', () => resolve(undefined));
  });
  const timeout = setTimeout(() => timer.abort(), Math.max(1, deadline.remaining()));
  const cancel = (): void => timer.abort();
  signal.addEventListener('abort', cancel);
  try {
    await click(session, target, deadline, {}, signal);
    const chooser = await opened;
    signal.throwIfAborted();
    if (chooser?.element === undefined) {
      throw new EngineError('NOT_ACTIONABLE', 'upload clicked the control but it opened no file chooser', { retryable: false });
    }
    await send(chooser.context, new ElementRef(chooser.element.sharedId));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    off();
  }
}

/**
 * Drags the source onto the target: the target is brought into view first,
 * then the source, and the target is read again where the source's scroll
 * left it, so neither end is a stale point. A target the source's scroll
 * pushed out of view fails rather than dropping beside it.
 */
async function dragTo(session: BidiSession, source: NodeTarget, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await pointerPoint(session, target, deadline, false, signal);
  const from = await pointerPoint(session, source, deadline, true, signal);
  const local = await session.run(readActionPoint, [target.element, { scroll: false, key: CLOSED_SHADOW_ROOTS_KEY }], target.context);
  if (local.state !== 'ok') throw new EngineError('NOT_ACTIONABLE', `dragTo: the target cannot be shown with the source: ${blocker(local)}`, { retryable: false });
  const box = await session.frames.viewportBox(session.connection, target.context);
  if (box === null) throw new EngineError('NOT_ACTIONABLE', 'dragTo: the target is in a frame that lays out no box, or is rotated', { retryable: false });
  const to = box === undefined ? local : { x: Math.round(box.origin.x + local.x * box.scale.x), y: Math.round(box.origin.y + local.y * box.scale.y) };
  await drag(session, from, to, 0, signal);
}

/**
 * Presses at `from`, moves to `to` over `durationMs`, and releases there.
 * On Chromium a drag the page starts carries its data to the drop
 * (`chromiumDrag`). Firefox's remote agent synthesizes no drop
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879), so there the
 * pointer moves alone.
 */
async function drag(session: BidiSession, from: ViewportPoint, to: ViewportPoint, durationMs: number, signal: AbortSignal): Promise<void> {
  if (session.settings.browser !== 'chromium') {
    await session.sendInput(dragSources(from, to, durationMs), signal);
    return;
  }
  const context = session.requireContext();
  const documents = await session.documentContexts(context);
  signal.throwIfAborted();
  session.mutated();
  await chromiumDrag(session.connection, context, documents, dragPath(from, to), dragStepMs(durationMs), signal);
  session.pointer = { x: to.x, y: to.y };
}

/** Wheels at a viewport point by a swipe of `extent`'s size, then waits for the frame that renders it. */
async function wheel(
  session: BidiSession,
  at: ViewportPoint,
  extent: ViewportSize,
  direction: Parameters<typeof wheelDelta>[0],
  momentum: Parameters<typeof swipeDistance>[1],
  signal: AbortSignal,
): Promise<void> {
  const distance = swipeDistance(direction === 'up' || direction === 'down' ? extent.height : extent.width, momentum);
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  const point = nearestPixel(at);
  await session.sendInput(wheelSources(point.x, point.y, deltaX, deltaY), signal);
  await session.run(nextFrame, []);
}
