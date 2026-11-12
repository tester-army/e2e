/** What a test that captures a document keeps of the nodes the capture published. */

import type { ElementHandle } from 'playwright-core';
import type { ListedTarget } from '../../src/refs.ts';

/** The nodes one capture published, with a handle to any of them on demand and one call to release them all. */
export class Published {
  private readonly targets = new Map<string, ListedTarget>();

  /** The `commit` callback a capture takes. */
  readonly commit = (id: string, target: ListedTarget): void => {
    this.targets.set(id, target);
  };

  /** The element a published id names. */
  element(id: string): Promise<ElementHandle<Element>> {
    const target = this.targets.get(id);
    if (target === undefined) throw new Error(`no published node ${id}`);
    return target.list.at(target.index);
  }

  /** Every published id. */
  ids(): string[] {
    return [...this.targets.keys()];
  }

  /** Releases the element lists behind every published node. */
  dispose(): void {
    for (const target of this.targets.values()) target.list.dispose();
    this.targets.clear();
  }
}
