/**
 * Observation metadata must not retain earlier captures in the browser, and
 * only child frames on the app's site enter the tree.
 */

import { chromium, type ElementHandle, type Page } from 'playwright';
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { captureDocument, type DocumentHost } from '../../src/observation.ts';
import type { readDocumentSemanticsFunction } from '../../src/read-node.ts';

/** Every name in one observation tree, depth first. */
function namesOf(node: SemanticNode, out: string[] = []): string[] {
  if (node.name !== undefined) out.push(node.name);
  for (const child of node.children ?? []) namesOf(child, out);
  return out;
}

/** One observation of the page with the given site, handles disposed. */
async function captureWithSite(page: Page, site: string | undefined): Promise<SemanticNode> {
  let nextId = 1;
  const published = new Map<string, ElementHandle<Element>>();
  const { tree } = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: (id, element) => { published.set(id, element); },
    },
    page,
    { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  await Promise.all([...published.values()].map((element) => element.dispose()));
  return tree;
}

it('reads a child frame on the app\'s site and leaves one from another deployment of the shared host out', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Every document answered locally: no vercel.app name resolves.
    await page.route('**/*', async (route) => {
      const { hostname } = new URL(route.request().url());
      const body =
        hostname === 'myapp.vercel.app'
          ? '<h1>App</h1>' +
            '<iframe title="Widget frame" src="https://widget.vercel.app/w"></iframe>' +
            '<iframe title="Api frame" src="https://api.myapp.vercel.app/a"></iframe>'
          : `<button>${hostname === 'widget.vercel.app' ? 'Widget button' : 'Api button'}</button>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    await page.goto('https://myapp.vercel.app/');
    const scoped = namesOf(await captureWithSite(page, 'myapp.vercel.app'));
    expect(scoped).toContain('Api frame');
    expect(scoped).toContain('Widget frame');
    expect(scoped).toContain('Api button');
    expect(scoped).not.toContain('Widget button');
    // Without a site no child frame is read; both stay boundary nodes.
    const unscoped = namesOf(await captureWithSite(page, undefined));
    expect(unscoped).toContain('Api frame');
    expect(unscoped).not.toContain('Api button');
    expect(unscoped).not.toContain('Widget button');
  } finally {
    await browser.close();
  }
});

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
