/** Observed nodes share one in-page array: handles are made when an action reaches for one, and all go with the list. */

import type { JSHandle } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { ElementList } from '../../src/element-list.ts';
import { RefRegistry, type ListedTarget } from '../../src/refs.ts';

/** A scripted array handle whose `evaluateHandle` answers with one element handle per call. */
function scripted(options: { missing?: boolean; gate?: Promise<void> } = {}) {
  const made: { index: number; dispose: ReturnType<typeof vi.fn> }[] = [];
  const dispose = vi.fn(() => Promise.resolve());
  const evaluateHandle = vi.fn(async (_read: unknown, index: number) => {
    await options.gate;
    const element = { index, dispose: vi.fn(() => Promise.resolve()), asElement: () => (options.missing === true ? null : element) };
    made.push(element);
    return element;
  });
  const handle = { dispose, evaluateHandle } as unknown as JSHandle;
  return { handle, dispose, evaluateHandle, made };
}

describe('ElementList', () => {
  it('makes no element handle until a node is reached, then keeps the one it made', async () => {
    const { handle, evaluateHandle } = scripted();
    const list = new ElementList(handle);
    expect(evaluateHandle).not.toHaveBeenCalled();
    const first = await list.at(3);
    expect(await list.at(3)).toBe(first);
    expect(evaluateHandle).toHaveBeenCalledOnce();
    await list.at(4);
    expect(evaluateHandle).toHaveBeenCalledTimes(2);
  });

  it('shares one handle between concurrent reads of a node', async () => {
    const { handle, evaluateHandle } = scripted();
    const list = new ElementList(handle);
    const [a, b] = await Promise.all([list.at(1), list.at(1)]);
    expect(a).toBe(b);
    expect(evaluateHandle).toHaveBeenCalledOnce();
  });

  it('releases the array and every handle made from it, once', async () => {
    const { handle, dispose, made } = scripted();
    const list = new ElementList(handle);
    await list.at(0);
    await list.at(1);
    list.dispose();
    list.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(made.map((element) => element.dispose.mock.calls.length)).toEqual([1, 1]);
  });

  it('reports a node whose element is gone as stale, and retries a later read', async () => {
    const gone = scripted({ missing: true });
    const list = new ElementList(gone.handle);
    await expect(list.at(0)).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await expect(list.at(0)).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(gone.evaluateHandle).toHaveBeenCalledTimes(2);
    expect(gone.made[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('reports a read that lost its document to a navigation as stale', async () => {
    const { handle, evaluateHandle } = scripted();
    evaluateHandle.mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'));
    const list = new ElementList(handle);
    await expect(list.at(0)).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('refuses a read after disposal and releases a handle that arrives late', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { handle, made } = scripted({ gate });
    const list = new ElementList(handle);
    const late = list.at(0);
    const outcome = expect(late).rejects.toMatchObject({ code: 'NODE_STALE' });
    list.dispose();
    open();
    await outcome;
    expect(made[0]?.dispose).toHaveBeenCalledOnce();
    await expect(list.at(1)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
});

describe('observed refs', () => {
  const target = (list: ElementList, index: number): ListedTarget => ({ kind: 'listed', list, index });

  it('resolve to the element at their position in the list the observation published', async () => {
    const registry = new RefRegistry();
    const { handle, made } = scripted();
    const list = new ElementList(handle);
    const capture = registry.beginCapture();
    registry.publish(capture, {
      snapshot: { location: '', root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } },
      generation: new Map([['n1', target(list, 0)], ['n2', target(list, 1)]]),
    });
    const resolved = await registry.lookup({ id: 'n2', revision: '' });
    expect(made.map((element) => element.index)).toEqual([1]);
    expect(resolved).toEqual({ kind: 'element', element: made[0] });
  });

  it('release a superseded generation once however many nodes it listed, and then go stale', async () => {
    const registry = new RefRegistry();
    const { handle, dispose } = scripted();
    const list = new ElementList(handle);
    const snapshot = { location: '', root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } };
    registry.publish(registry.beginCapture(), { snapshot, generation: new Map([['n1', target(list, 0)], ['n2', target(list, 1)], ['n3', target(list, 2)]]) });
    registry.publish(registry.beginCapture(), { snapshot, generation: new Map() });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(registry.lookup({ id: 'n1', revision: '' })).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
});
