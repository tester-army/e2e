/**
 * The modal show-order record, run as page code against a scripted dialog
 * class: each `showModal()` gets the next number and a dialog shown again a
 * new one, a call that throws records nothing, and a browser without
 * `showModal` gets no record.
 */

import { describe, expect, it } from 'vitest';
import { MODAL_ORDER_INIT_SCRIPT } from '../../src/modal-dialogs.ts';

/** The record's key as the in-page reader spells it (`read-semantics.ts`), so the two literals must agree. */
const KEY = Symbol.for('e2e.modalDialogOrder');

/** A dialog whose `showModal` throws on a dialog already open, as the browser's does. */
class FakeDialog {
  open = false;
  showModal(): void {
    if (this.open) throw new Error('InvalidStateError: the dialog is already open');
    this.open = true;
  }
}

/** Runs the init script against a page global of its own, with `dialogClass` as `HTMLDialogElement`. */
function install(global: object, dialogClass: unknown): void {
  const run = new Function('globalThis', 'HTMLDialogElement', MODAL_ORDER_INIT_SCRIPT) as (global: object, dialog: unknown) => void;
  run(global, dialogClass);
}

describe('modal show-order record', () => {
  it('numbers every showModal call, and a dialog shown again gets a new number', () => {
    const global = {};
    const dialogClass = class extends FakeDialog {};
    install(global, dialogClass);
    const order = Reflect.get(global, KEY) as WeakMap<object, number>;
    expect(order).toBeInstanceOf(WeakMap);
    const first = new dialogClass();
    const second = new dialogClass();
    first.showModal();
    second.showModal();
    expect([order.get(first), order.get(second)]).toEqual([1, 2]);
    first.open = false;
    first.showModal();
    expect(order.get(first)).toBe(3);
  });

  it('records nothing for a show that throws, and installs once per document', () => {
    const global = {};
    const dialogClass = class extends FakeDialog {};
    install(global, dialogClass);
    const order = Reflect.get(global, KEY) as WeakMap<object, number>;
    const dialog = new dialogClass();
    dialog.showModal();
    expect(() => dialog.showModal()).toThrow('already open');
    expect(order.get(dialog)).toBe(1);
    const wrapped = dialogClass.prototype.showModal;
    install(global, dialogClass);
    expect(Reflect.get(global, KEY)).toBe(order);
    expect(dialogClass.prototype.showModal).toBe(wrapped);
  });

  it('leaves a browser without showModal alone', () => {
    const global = {};
    install(global, undefined);
    expect(KEY in global).toBe(false);
  });
});
