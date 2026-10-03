/** Observation metadata must not retain earlier captures in the browser. */

import { chromium, type ElementHandle } from 'playwright-core';
import { expect, it } from 'vitest';
import { captureDocument, type DocumentHost } from '../../src/observation.ts';
import type { readDocumentSemanticsFunction } from '../../src/read-node.ts';

it('collects captured metadata while published element handles stay actionable', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<button onclick="this.textContent = \'Clicked\'">Click me</button>');
    const metadata = await page.evaluateHandle(() => [] as WeakRef<object>[]);
    const evaluateHandle = page.evaluateHandle.bind(page);
    const host: DocumentHost = {
      evaluateHandle: (async (...args: Parameters<DocumentHost['evaluateHandle']>) => {
        const captured = await evaluateHandle(...args);
        await captured.evaluate((value, refs) => {
          const observation = value as ReturnType<typeof readDocumentSemanticsFunction>;
          refs.push(new WeakRef(observation.nodes), new WeakRef(observation.ids));
        }, metadata);
        return captured;
      }) as DocumentHost['evaluateHandle'],
    };
    let nextId = 1;
    let published = new Map<string, ElementHandle<Element>>();
    let buttonId: string | undefined;
    for (let index = 0; index < 3; index += 1) {
      const previous = published;
      published = new Map();
      const snapshot = await captureDocument(
        {
          testIdAttribute: 'data-testid',
          site: undefined,
          reserveIds: (count) => { const first = nextId; nextId += count; return first; },
          commit: (id, element) => { published.set(id, element); },
        },
        host,
        { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal },
      );
      await Promise.all([...previous.values()].map((element) => element.dispose()));
      expect(snapshot.nodeCount).toBe(2);
      buttonId = snapshot.tree.children?.find((node) => node.role === 'button')?.ref.id;
    }
    const session = await page.context().newCDPSession(page);
    await session.send('HeapProfiler.collectGarbage');
    expect(await metadata.evaluate((refs) => refs.map((ref) => ref.deref() === undefined)))
      .toEqual([true, true, true, true, true, true]);
    expect(buttonId).toBeDefined();
    await published.get(buttonId!)!.click();
    expect(await page.getByRole('button').innerText()).toBe('Clicked');
    await Promise.all([...published.values()].map((element) => element.dispose()));
    await metadata.dispose();
  } finally {
    await browser.close();
  }
});
