/**
 * In-page pointer for recordings.
 *
 * A screencast captures the page's pixels and nothing else: no OS pointer, so
 * a recording shows elements changing with no visible cause. This overlay
 * renders an SVG pointer inside the page so it is in every frame, and
 * `withCursorFollowing` glides it to each target right before acting on it,
 * with a pulse on a tap. It is cosmetic and only exists while a video records.
 *
 * The overlay lives in a shadow-DOM host with `pointer-events: none` and
 * `aria-hidden`, so it never intercepts input, never appears in an
 * observation, and page CSS cannot restyle it. Movement is a composited,
 * transform-only transition: never left/top, which would relayout on a busy
 * main thread and stutter in the recording. Split per-axis easing gives the
 * path a slight curve, and the duration scales with the distance so short hops
 * stay snappy while long glides do not teleport. The pointer survives
 * navigations (its position is kept in `sessionStorage`) and single-page apps
 * that replace `document.body` (a timer re-attaches the host).
 *
 * It is hidden while model-facing pixels and evidence screenshots are taken,
 * so nothing the harness reasons about ever contains it.
 *
 * Every call here is bounded and best-effort: an evaluate on a wedged page
 * would otherwise stall the action it decorates, and a cosmetic failure must
 * never fail a step.
 */

import type { ElementHandle, Locator, Page } from 'playwright';
import type { LocatorAction } from '@e2edev/e2e/engine';
import type { ActionTarget } from './support.ts';

/** Shortest glide, for small hops; the action waits for it, so both bounds stay tight. */
const CURSOR_TRAVEL_MIN_MS = 100;

/** Longest glide, for a full-viewport move. */
const CURSOR_TRAVEL_MAX_MS = 250;

/** Budget for resolving where the target is; the overlay must never slow an action down. */
const CURSOR_TARGET_TIMEOUT_MS = 1_000;

/** Hard cap on every overlay evaluate: the page's main thread may be wedged. */
const OVERLAY_EVALUATE_TIMEOUT_MS = 1_000;

const OVERLAY_HOST_ID = '__e2e_cursor_overlay__';

/** Actions a pointer performs, so the pointer glides to their target first. */
const POINTER_ACTIONS: ReadonlySet<LocatorAction['kind']> = new Set([
  'tap',
  'doubleTap',
  'longPress',
  'fill',
  'clear',
  'check',
  'uncheck',
  'hover',
  'selectOption',
  'dragTo',
  'swipe',
]);

/** Pointer actions that press: the pointer pulses as they dispatch. */
const TAP_ACTIONS: ReadonlySet<LocatorAction['kind']> = new Set(['tap', 'doubleTap', 'longPress', 'check', 'uncheck']);

/**
 * Installed once per document. Registers `window.e2eCursorOverlay` with
 * `move`, `pulse`, and `setHidden`, and mounts the host lazily.
 */
const OVERLAY_INSTALL_SCRIPT = `(() => {
  if (window.e2eCursorOverlay) return;
  var HOST_ID = ${JSON.stringify(OVERLAY_HOST_ID)};
  var STORAGE_KEY = '__e2e_cursor_state__';
  var CURSOR_SVG = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M5.5 3.21V20.79c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.85a.5.5 0 0 0-.85.36Z" '
    + 'fill="#1f1f1f" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var MIN_MS = ${CURSOR_TRAVEL_MIN_MS};
  var MAX_MS = ${CURSOR_TRAVEL_MAX_MS};
  var state = { el: null, x: null, y: null, cursor: null, visible: false, hidden: false, lastX: 0, lastY: 0 };

  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ x: state.lastX, y: state.lastY, visible: state.visible }));
    } catch (e) {}
  }

  function loadState() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
      return parsed;
    } catch (e) { return null; }
  }

  // Places the pointer instantly: after a navigation, and after a body wipe.
  function place(x, y) {
    state.x.style.transitionDuration = '0ms, 150ms';
    state.y.style.transitionDuration = '0ms';
    state.x.style.transform = 'translate3d(' + x + 'px,0,0)';
    state.y.style.transform = 'translate3d(0,' + y + 'px,0)';
    state.x.style.opacity = '1';
    state.visible = true;
    state.lastX = x;
    state.lastY = y;
  }

  function ensureHost() {
    if (state.el && state.el.isConnected) return state.cursor;
    var parent = document.body || document.documentElement;
    if (!parent) return null;
    var existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    var host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:layout;';
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = '\\n'
      + '.e2e-x,.e2e-y{position:fixed;left:0;top:0;will-change:transform;}'
      + '.e2e-x{transition:transform ' + MAX_MS + 'ms cubic-bezier(.25,.1,.25,1),opacity 150ms ease;opacity:0;}'
      + '.e2e-y{transition:transform ' + MAX_MS + 'ms cubic-bezier(.45,.05,.35,1);}'
      + '.e2e-cursor{filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));}'
      + '.e2e-cursor.e2e-tap{animation:e2e-cursor-tap 250ms ease;}'
      + '@keyframes e2e-cursor-tap{0%{transform:scale(1)}40%{transform:scale(.78)}100%{transform:scale(1)}}';
    shadow.appendChild(style);
    var xWrap = document.createElement('div');
    xWrap.className = 'e2e-x';
    var yWrap = document.createElement('div');
    yWrap.className = 'e2e-y';
    var cursor = document.createElement('div');
    cursor.className = 'e2e-cursor';
    cursor.innerHTML = CURSOR_SVG;
    yWrap.appendChild(cursor);
    xWrap.appendChild(yWrap);
    shadow.appendChild(xWrap);
    parent.appendChild(host);
    state.el = host;
    state.x = xWrap;
    state.y = yWrap;
    state.cursor = cursor;
    if (state.hidden) host.style.display = 'none';
    if (state.visible) place(state.lastX, state.lastY);
    return cursor;
  }

  window.e2eCursorOverlay = {
    move: function (x, y) {
      // Actions and captures are serialized by the harness, so a move proves
      // the capture that hid the pointer is over, even if its unhide was lost.
      state.hidden = false;
      var cursor = ensureHost();
      if (!cursor) return 0;
      if (state.el.style.display) state.el.style.display = '';
      var distance = state.visible ? Math.hypot(x - state.lastX, y - state.lastY) : 0;
      var duration = state.visible ? Math.round(Math.min(MAX_MS, Math.max(MIN_MS, distance * 0.35))) : 0;
      state.x.style.transitionDuration = duration + 'ms, 150ms';
      state.y.style.transitionDuration = duration + 'ms';
      state.x.style.transform = 'translate3d(' + x + 'px,0,0)';
      state.y.style.transform = 'translate3d(0,' + y + 'px,0)';
      state.x.style.opacity = '1';
      state.visible = true;
      state.lastX = x;
      state.lastY = y;
      saveState();
      return duration;
    },
    pulse: function () {
      var cursor = ensureHost();
      if (!cursor || !state.visible) return;
      cursor.classList.remove('e2e-tap');
      void cursor.offsetWidth;
      cursor.classList.add('e2e-tap');
    },
    setHidden: function (hidden) {
      state.hidden = !!hidden;
      if (!state.el || !state.el.isConnected) return;
      state.el.style.display = hidden ? 'none' : '';
      // A synchronous reflow, so a screenshot taken right after cannot race the style change.
      void state.el.offsetHeight;
    },
  };

  function init() {
    var cursor = ensureHost();
    var stored = loadState();
    if (cursor && stored && stored.visible) place(stored.x, stored.y);
    setInterval(function () {
      if (!state.el || !state.el.isConnected) ensureHost();
    }, 500);
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();`;

interface OverlayWindow {
  e2eCursorOverlay?: {
    move(x: number, y: number): number;
    pulse(): void;
    setHidden(hidden: boolean): void;
  };
}

/** Where the pointer aims: the target's viewport-relative rectangle. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Installs the overlay on every document the page will show, and on the
 * current one. Idempotent per document. A page without a document yet is
 * covered by the init script on its first navigation.
 */
export async function installCursorOverlay(page: Page): Promise<void> {
  await page.addInitScript(OVERLAY_INSTALL_SCRIPT).catch(() => undefined);
  await bounded(page.evaluate(OVERLAY_INSTALL_SCRIPT));
}

/** Runs one overlay evaluate with a hard time bound; every failure is swallowed. */
async function bounded(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), OVERLAY_EVALUATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Glides the pointer to a viewport point and waits for the travel to finish. */
async function animateCursorToPoint(page: Page, x: number, y: number): Promise<void> {
  let travelMs = 0;
  const moved = await bounded(
    page
      .evaluate(
        ([px, py]) => {
          const overlay = (window as unknown as OverlayWindow).e2eCursorOverlay;
          return overlay === undefined ? 0 : overlay.move(px, py);
        },
        [x, y] as const,
      )
      .then((duration) => {
        travelMs = duration;
      }),
  );
  if (moved && travelMs > 0) await page.waitForTimeout(travelMs).catch(() => undefined);
}

/**
 * Glides the pointer to the center of an action target, best-effort. The
 * target is scrolled into view first: the action itself auto-scrolls, and
 * aiming at pre-scroll coordinates would send the pointer off-screen while
 * the action lands elsewhere. A center that is still outside the viewport (a
 * tall element) is clamped so the pointer tracks the action instead of
 * silently staying put.
 */
async function animateCursorToTarget(page: Page, target: ActionTarget): Promise<void> {
  try {
    const box = await targetBox(target);
    if (box === null) return;
    let x = box.x + box.width / 2;
    let y = box.y + box.height / 2;
    const viewport = page.viewportSize();
    if (viewport !== null) {
      x = Math.min(Math.max(x, 8), viewport.width - 8);
      y = Math.min(Math.max(y, 8), viewport.height - 8);
    }
    await animateCursorToPoint(page, x, y);
  } catch {
    // The target may be detached or slow to resolve; the action reports that, not the pointer.
  }
}

async function targetBox(target: ActionTarget): Promise<Box | null> {
  // One budget for both steps: scrolling and measuring share it, so a target
  // that never resolves costs the action the budget once, not twice.
  const deadline = Date.now() + CURSOR_TARGET_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (target.kind === 'locator') {
    const locator: Locator = target.locator;
    await locator.scrollIntoViewIfNeeded({ timeout: remaining() }).catch(() => undefined);
    return locator.boundingBox({ timeout: remaining() });
  }
  const element: ElementHandle<Element> = target.element;
  await element.scrollIntoViewIfNeeded({ timeout: remaining() }).catch(() => undefined);
  return element.boundingBox();
}

/** Plays the tap pulse on the pointer, best-effort. */
async function pulseCursor(page: Page): Promise<void> {
  await bounded(
    page.evaluate(() => {
      (window as unknown as OverlayWindow).e2eCursorOverlay?.pulse();
    }),
  );
}

/** Hides the pointer while `work` runs, so a capture never contains it. */
export async function withCursorHidden<T>(page: Page, work: () => Promise<T>): Promise<T> {
  const setHidden = (hidden: boolean) =>
    bounded(
      page.evaluate((value) => {
        (window as unknown as OverlayWindow).e2eCursorOverlay?.setHidden(value);
      }, hidden),
    );
  await setHidden(true);
  try {
    return await work();
  } finally {
    await setHidden(false);
  }
}

/**
 * Runs a locator action with the pointer following it: a glide to the target
 * first, and a pulse as a tap dispatches. An action no pointer performs (a key
 * press, a scroll) dispatches untouched.
 */
export async function withCursorFollowing(
  page: Page,
  target: ActionTarget,
  kind: LocatorAction['kind'],
  dispatch: () => Promise<void>,
): Promise<void> {
  if (!POINTER_ACTIONS.has(kind)) return dispatch();
  await animateCursorToTarget(page, target);
  const pulse = TAP_ACTIONS.has(kind) ? pulseCursor(page) : undefined;
  await dispatch();
  if (pulse !== undefined) await pulse;
}
