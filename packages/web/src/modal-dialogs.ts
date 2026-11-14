/**
 * The order modal dialogs were shown in, kept for the reader: a modal
 * `<dialog>` makes everything outside it inert, and only the one shown last
 * stays live when several are open, which neither tree order nor
 * `dialog:modal` tells apart.
 */

/**
 * Where the init script below records each modal dialog's show order, and
 * where the in-page reader looks for it. The reader is serialized into the
 * page and cannot import this constant, so the literal is repeated inside it;
 * the two must agree, like `CLOSED_SHADOW_ROOTS_KEY`.
 */
const MODAL_ORDER_KEY = 'e2e.modalDialogOrder';

/**
 * Context init script that numbers each opening of a dialog that
 * `showModal()` has shown: a `WeakMap` from dialog to the count of openings
 * so far, under a well-known symbol, so the highest number among the open
 * modal dialogs is the one on top. Such a dialog can open again without
 * `showModal()` (a `show-modal` command), so the first `showModal()` call
 * also listens for the dialog's `beforetoggle` to `open`, which every
 * opening fires before it happens, and numbers it there; a browser that fires
 * none on a dialog is numbered by the call itself. A call on a dialog already
 * open records nothing: on a modal one it changes nothing, and on one shown
 * without a modal it throws, as it does on a dialog that is not connected. A
 * dialog no `showModal()` call has seen gets no number, and the reader reads
 * the order as unknown. Keyed by the dialog and never enumerated, so it holds
 * nothing alive. A browser without `showModal` gets no record, and the reader
 * goes by focus alone.
 */
export const MODAL_ORDER_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(MODAL_ORDER_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;
  const order = new WeakMap();
  const watched = new WeakSet();
  let opened = 0;
  Object.defineProperty(globalThis, key, { value: order, enumerable: false, configurable: false, writable: false });
  const listen = EventTarget.prototype.addEventListener;
  const number = (dialog) => {
    opened += 1;
    order.set(dialog, opened);
  };
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    const dialog = this;
    if (!watched.has(dialog)) {
      watched.add(dialog);
      listen.call(dialog, 'beforetoggle', (event) => {
        if (event.newState === 'open') number(dialog);
      });
    }
    const opens = !dialog.open;
    const before = order.get(dialog);
    const result = showModal.call(dialog);
    if (opens && order.get(dialog) === before) number(dialog);
    return result;
  };
})();`;
