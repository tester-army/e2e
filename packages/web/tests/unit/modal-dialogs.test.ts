/**
 * The modal show-order record, run as page code against a scripted dialog
 * class: each opening of a dialog `showModal()` has shown gets the next
 * number, a `show-modal` command reopening one included; a call on a dialog
 * already open records nothing; a browser that fires no `beforetoggle` on a
 * dialog is numbered by the call; and a browser without `showModal` gets no
 * record.
 */

import { describe, expect, it } from 'vitest';
import { MODAL_ORDER_INIT_SCRIPT } from '../../src/modal-dialogs.ts';

/** The record's key as the in-page reader spells it (`read-semantics.ts`), so the two literals must agree. */
const KEY = Symbol.for('e2e.modalDialogOrder');

type Listener = (event: { newState: string }) => void;

/** `EventTarget` as the script reads it: listeners kept per instance. */
class FakeEventTarget {
  listeners: Listener[] = [];
  addEventListener(type: string, listener: Listener): void {
    if (type === 'beforetoggle') this.listeners.push(listener);
  }
}

/**
 * A dialog whose `showModal` acts as the browser's does: on a dialog already
 * modal it changes nothing, on one shown without a modal it throws, and
 * otherwise it fires `beforetoggle` before it opens. `openByCommand` opens it
 * the way a `show-modal` command does, without calling `showModal`.
 */
class FakeDialog extends FakeEventTarget {
  open = false;
  modal = false;
  firesToggle = true;
  show(): void {
    this.open = true;
  }
  showModal(): void {
    if (this.open && this.modal) return;
    if (this.open) throw new Error('InvalidStateError: the dialog is already open');
    this.openModal();
  }
  openByCommand(): void {
    if (!this.open) this.openModal();
  }
  close(): void {
    this.open = false;
    this.modal = false;
  }
  private openModal(): void {
    if (this.firesToggle) for (const listener of this.listeners) listener({ newState: 'open' });
    this.open = true;
    this.modal = true;
  }
}

/** Runs the init script against a page global of its own, with fakes as `HTMLDialogElement` and `EventTarget`. */
function install(global: object, dialogClass: unknown): void {
  const run = new Function('globalThis', 'HTMLDialogElement', 'EventTarget', MODAL_ORDER_INIT_SCRIPT) as (
    global: object,
    dialog: unknown,
    eventTarget: unknown,
  ) => void;
  run(global, dialogClass, FakeEventTarget);
}

/** A fresh dialog class with the record installed for it. */
function recorded(): { order: WeakMap<object, number>; Dialog: typeof FakeDialog; global: object } {
  const global = {};
  const Dialog = class extends FakeDialog {};
  install(global, Dialog);
  return { order: Reflect.get(global, KEY) as WeakMap<object, number>, Dialog, global };
}

describe('modal show-order record', () => {
  it('numbers every opening, and a dialog closed and shown again gets a new number', () => {
    const { order, Dialog } = recorded();
    expect(order).toBeInstanceOf(WeakMap);
    const first = new Dialog();
    const second = new Dialog();
    first.showModal();
    second.showModal();
    expect([order.get(first), order.get(second)]).toEqual([1, 2]);
    first.close();
    first.showModal();
    expect(order.get(first)).toBe(3);
  });

  it('numbers a dialog a show-modal command reopens, so it outranks one shown while it was closed', () => {
    const { order, Dialog } = recorded();
    const reopened = new Dialog();
    const between = new Dialog();
    reopened.showModal();
    reopened.close();
    between.showModal();
    reopened.openByCommand();
    expect([order.get(reopened), order.get(between)]).toEqual([3, 2]);
    // A dialog no showModal() call has seen stays unknown to the reader.
    const commandOnly = new Dialog();
    commandOnly.openByCommand();
    expect(order.get(commandOnly)).toBeUndefined();
  });

  it('records nothing for a call on a dialog already open, and installs once per document', () => {
    const { order, Dialog, global } = recorded();
    const lower = new Dialog();
    const upper = new Dialog();
    lower.showModal();
    upper.showModal();
    // The browser leaves `upper` on top, so the record must too.
    lower.showModal();
    expect([order.get(lower), order.get(upper)]).toEqual([1, 2]);
    const plain = new Dialog();
    plain.show();
    expect(() => plain.showModal()).toThrow('already open');
    expect(order.get(plain)).toBeUndefined();
    const wrapped = Dialog.prototype.showModal;
    install(global, Dialog);
    expect(Reflect.get(global, KEY)).toBe(order);
    expect(Dialog.prototype.showModal).toBe(wrapped);
  });

  it('numbers each showModal call itself on a browser that fires no beforetoggle on a dialog', () => {
    const { order, Dialog } = recorded();
    const first = new Dialog();
    const second = new Dialog();
    first.firesToggle = false;
    second.firesToggle = false;
    first.showModal();
    second.showModal();
    first.showModal();
    expect([order.get(first), order.get(second)]).toEqual([1, 2]);
  });

  it('leaves a browser without showModal alone', () => {
    const global = {};
    install(global, undefined);
    expect(KEY in global).toBe(false);
  });
});
