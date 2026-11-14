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
 * Context init script that numbers every `showModal()` call that opens a
 * dialog: a `WeakMap` from dialog to the count of modal shows so far, under a
 * well-known symbol. A dialog closed and shown again gets a new number, so
 * the highest number among the open modal dialogs is the one on top. A call
 * on a dialog already open records nothing: on a modal one it changes
 * nothing, and on one shown without a modal it throws, as it does on a
 * dialog that is not connected. Keyed by the dialog and never enumerated, so
 * it holds nothing alive. A browser without `showModal` gets no record, and
 * the reader goes by focus alone.
 */
export const MODAL_ORDER_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(MODAL_ORDER_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;
  const order = new WeakMap();
  let shown = 0;
  Object.defineProperty(globalThis, key, { value: order, enumerable: false, configurable: false, writable: false });
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    const opens = !this.open;
    const result = showModal.call(this);
    if (opens) {
      shown += 1;
      order.set(this, shown);
    }
    return result;
  };
})();`;
