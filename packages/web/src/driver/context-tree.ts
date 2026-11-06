/**
 * The browser's browsing contexts as one tree: each context's user context
 * and parent, and the frames in it. The session's events keep it current,
 * and a snapshot fills in the contexts already open when the driver
 * connected, so a page it attached to owns its frames from the start.
 */

import type { BrowsingContext } from 'webdriver-bidi-protocol';

/** One browsing context: the user context it belongs to, its parent (none for a tab), and its frames. */
interface ContextNode {
  readonly userContext: string;
  readonly parent: string | undefined;
  readonly children: Set<string>;
}

/** Every browsing context the session knows of, with its user context, parent, and frames. */
export class ContextTree {
  private readonly nodes = new Map<string, ContextNode>();
  /** Contexts destroyed while a snapshot was read, which the snapshot may still list; undefined while none is read. */
  private destroyedDuringSync: Set<string> | undefined;

  /** Records `context`, with its own user context or, for a frame the event names none for, its parent's. */
  created(context: string, userContext: string | undefined, parent: string | null | undefined): void {
    if (this.nodes.has(context)) return;
    const parentNode = parent == null ? undefined : this.nodes.get(parent);
    this.nodes.set(context, { userContext: userContext ?? parentNode?.userContext ?? '', parent: parent ?? undefined, children: new Set() });
    parentNode?.children.add(context);
  }

  /** Forgets a closed context and every frame in it. */
  destroyed(context: string): void {
    this.destroyedDuringSync?.add(context);
    const node = this.nodes.get(context);
    if (node === undefined) return;
    if (node.parent !== undefined) this.nodes.get(node.parent)?.children.delete(context);
    for (const gone of this.subtree(context)) this.nodes.delete(gone);
  }

  /**
   * Adds the contexts `read` lists (`browsingContext.getTree`), with their
   * frames, to what the events have recorded. Call it with the context
   * events already routed here: a context created meanwhile is recorded
   * once, and one destroyed meanwhile is not brought back by a snapshot that
   * still lists it.
   */
  async sync(read: () => Promise<BrowsingContext.InfoList>): Promise<void> {
    const destroyed = new Set<string>();
    this.destroyedDuringSync = destroyed;
    try {
      const add = (infos: BrowsingContext.InfoList, parent: string | null): void => {
        for (const info of infos) {
          if (destroyed.has(info.context)) continue;
          this.created(info.context, info.userContext, parent);
          add(info.children ?? [], info.context);
        }
      };
      add(await read(), null);
    } finally {
      if (this.destroyedDuringSync === destroyed) this.destroyedDuringSync = undefined;
    }
  }

  /** The user context `context` belongs to; undefined for one never seen. */
  owner(context: string): string | undefined {
    return this.nodes.get(context)?.userContext;
  }

  /** The top-level browsing context `context` is, or is a frame of. */
  top(context: string): string {
    let top = context;
    for (let parent = this.nodes.get(top)?.parent; parent !== undefined; parent = this.nodes.get(top)?.parent) top = parent;
    return top;
  }

  /** `context` and every frame in it, however deep; just `context` for one never seen. */
  subtree(context: string): Set<string> {
    const found = new Set([context]);
    for (const each of found) for (const child of this.nodes.get(each)?.children ?? []) found.add(child);
    return found;
  }
}
