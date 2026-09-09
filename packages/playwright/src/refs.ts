/**
 * Node reference registry for one attempt: the ids the engine mints for
 * located and observed nodes and the Playwright targets behind them.
 *
 * Two populations with different lifetimes live here. Locator-backed refs
 * from `locate` hold no live handles and are pruned oldest-first past a
 * bound. Handle-backed refs from `observe` form one generation per
 * observation: the whole generation is swapped atomically and the superseded
 * one disposed in a sweep, so locator-ref eviction can never destroy a handle
 * an in-flight observation still references.
 */

import { EngineError, type NodeRef } from '@e2edev/e2e/engine';
import type { ActionTarget } from './support.ts';

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_STORED_REFS = 2048;

export class RefRegistry {
  private counter = 0;
  private readonly located = new Map<string, ActionTarget>();
  private observation = new Map<string, ActionTarget>();

  mintId(): string {
    this.counter += 1;
    return `n${this.counter}`;
  }

  /** First id a captured document may stamp on a node it sees for the first time. */
  idSeed(): number {
    return this.counter + 1;
  }

  /** Records the first id a captured document left unused, so minting never reuses a stamped one. */
  advanceIds(nextId: number): void {
    this.counter = Math.max(this.counter, nextId - 1);
  }

  /** Stores one located target under a fresh id, pruning the oldest past the bound. */
  storeLocated(target: ActionTarget): string {
    const id = this.mintId();
    this.located.set(id, target);
    for (const [oldest, evicted] of this.located) {
      if (this.located.size <= MAX_STORED_REFS) break;
      this.located.delete(oldest);
      if (evicted.kind === 'element') void evicted.element.dispose().catch(() => undefined);
    }
    return id;
  }

  /**
   * Ids are the engine's; revisions are the harness's. The adapter already
   * rejected a ref from a superseded resolution, so lookup is by id alone.
   */
  lookup(ref: NodeRef): ActionTarget {
    const target = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (target === undefined) {
      throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    }
    return target;
  }

  /** Publishes a captured generation, disposing the one it supersedes. */
  publish(generation: Map<string, ActionTarget>): void {
    RefRegistry.dispose(this.observation);
    this.observation = generation;
  }

  /** Releases every ref of the attempt: located and observed alike. */
  clear(): void {
    RefRegistry.dispose(this.observation);
    this.observation = new Map();
    RefRegistry.dispose(this.located);
    this.located.clear();
  }

  /** Disposes every element handle in one observation generation. */
  static dispose(generation: ReadonlyMap<string, ActionTarget>): void {
    for (const target of generation.values()) {
      if (target.kind === 'element') void target.element.dispose().catch(() => undefined);
    }
  }
}
