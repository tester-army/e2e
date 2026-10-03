/** Element-backed located refs release their handles when pruned or cleared, like observation refs. */

import type { ElementHandle } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { RefRegistry } from '../../src/refs.ts';

function handle(): { element: ElementHandle<Element>; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(() => Promise.resolve());
  return { element: { dispose } as unknown as ElementHandle<Element>, dispose };
}

describe('located element refs', () => {
  it('are disposed when the attempt clears its refs', async () => {
    const refs = new RefRegistry();
    const pinned = handle();
    const id = refs.storeLocated({ kind: 'element', element: pinned.element });
    expect(refs.lookup({ id, revision: '' })).toEqual({ kind: 'element', element: pinned.element });
    refs.clear();
    await Promise.resolve();
    expect(pinned.dispose).toHaveBeenCalledTimes(1);
    expect(() => refs.lookup({ id, revision: '' })).toThrow(/stale/);
  });

  it('are disposed when pruned past the registry bound', async () => {
    const refs = new RefRegistry();
    const first = handle();
    refs.storeLocated({ kind: 'element', element: first.element });
    for (let i = 0; i < 2048; i += 1) refs.storeLocated({ kind: 'element', element: handle().element });
    await Promise.resolve();
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });
});
