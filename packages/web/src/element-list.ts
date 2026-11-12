/** The elements one document's observation walk read, kept behind a single in-page array. */

import type { ElementHandle, JSHandle } from 'playwright-core';
import { EngineError } from 'e2e/engine';
import { navigationStaleOr } from './support.ts';

/**
 * One handle to the in-page array the reader filled, and the element handles
 * made from it on demand.
 *
 * An observation can list thousands of nodes and an action touches a few, so a
 * handle per node would cost a round trip to create and another to release for
 * every node, every observation. The array keeps each element alive, which is
 * what a handle did: a ref names the element the walk read, never whatever sits
 * at that position now. Disposing the list releases the array and every handle
 * made from it.
 */
export class ElementList {
  private readonly resolved = new Map<number, Promise<ElementHandle<Element>>>();
  private disposed = false;

  constructor(readonly handle: JSHandle) {}

  /**
   * A new handle to one element of the walk. The caller owns it and disposes
   * it; a missing element, or a document replaced since the walk, is a stale node.
   */
  async fetch(index: number): Promise<ElementHandle<Element>> {
    const handle = await this.handle
      .evaluateHandle((elements: Element[], at: number) => elements[at], index)
      .catch((cause: unknown) => {
        throw navigationStaleOr(cause, 'resolve observed node');
      });
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (element === null) {
      void handle.dispose().catch(() => undefined);
      throw new EngineError('NODE_STALE', `observation node ${String(index)} lost its element`, { retryable: true });
    }
    return element;
  }

  /** The element of one node, made once and kept until the list is disposed. */
  at(index: number): Promise<ElementHandle<Element>> {
    if (this.disposed) return Promise.reject(staleList());
    let element = this.resolved.get(index);
    if (element === undefined) {
      element = this.fetch(index).then(
        (made) => {
          if (!this.disposed) return made;
          void made.dispose().catch(() => undefined);
          throw staleList();
        },
        (cause: unknown) => {
          this.resolved.delete(index);
          throw this.disposed ? staleList() : cause;
        },
      );
      this.resolved.set(index, element);
    }
    return element;
  }

  /** Releases the array and every element made from it; safe to call again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const element of this.resolved.values()) {
      void element.then((made) => made.dispose()).catch(() => undefined);
    }
    this.resolved.clear();
    void this.handle.dispose().catch(() => undefined);
  }
}

/** The observation the list belonged to was replaced or cleared, so its refs no longer bind. */
function staleList(): EngineError {
  return new EngineError('NODE_STALE', 'observation node references were released', { retryable: true });
}
