/** The real reader calls a node hidden by one predicate in both modes and says when aria-hidden is why. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle, LocatorExpression, OperationContext, SemanticNode } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { captureDocument, toSemanticNode } from '../../src/observation.ts';
import { readManySemanticsFunction, SECURE_FIELD_SELECTOR, type RawNodeData } from '../../src/read-node.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

let browser: Browser;
let page: Page;
let app: FixtureApp;
let artifactsDir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  app = await startFixtureApp();
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-visibility-'));
});

afterAll(async () => {
  await browser.close();
  await app.close();
  rmSync(artifactsDir, { recursive: true, force: true });
});

/** One observation of the page through the same capture the engine uses. */
async function capture() {
  let nextId = 1;
  const published = new Map<string, ElementHandle<Element>>();
  const captured = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: (id, element) => { published.set(id, element); },
    },
    page,
    { framePath: [], budget: 200, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  await Promise.all([...published.values()].map((element) => element.dispose()));
  return captured;
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** Test ids the walk included. */
async function walkedTestIds(): Promise<Set<string>> {
  const { tree } = await capture();
  return new Set(flatten(tree).map((node) => node.testId).filter((id): id is string => id !== undefined));
}

/** The single-node read `locate` makes of the one element carrying the test id. */
async function readOne(testId: string): Promise<RawNodeData> {
  const raws = await page.locator(`[data-testid="${testId}"]`).evaluateAll(readManySemanticsFunction, {
    testIdAttribute: 'data-testid',
    secureFieldSelector: SECURE_FIELD_SELECTOR,
    mode: { kind: 'node' as const },
  });
  expect(raws).toHaveLength(1);
  return raws[0]!;
}

describe('visibility', () => {
  it('reads a node under an aria-hidden ancestor as hidden by aria-hidden, and the walk leaves it out', async () => {
    await page.setContent(`
      <div aria-hidden="true"><p data-testid="following">Following</p></div>
      <div aria-hidden="true" id="host"></div>
      <p data-testid="shown">Shown</p>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
          '<p data-testid="shadowed">Shadow text</p>';
      </script>
    `);
    expect(await readOne('following')).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(await readOne('shadowed')).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(await readOne('shown')).toMatchObject({ states: { hidden: false }, hiddenBy: null });
    const walked = await walkedTestIds();
    expect(walked.has('following')).toBe(false);
    expect(walked.has('shadowed')).toBe(false);
    expect(walked.has('shown')).toBe(true);
  });

  it('marks decorative text inside a named link hidden by aria-hidden, while the link is shown', async () => {
    await page.setContent(`
      <a href="/" aria-label="Good Ppl" data-testid="link"><span aria-hidden="true" data-testid="decoration">Good Ppl</span></a>
    `);
    const decoration = await readOne('decoration');
    expect(decoration).toMatchObject({ states: { hidden: true }, hiddenBy: 'aria-hidden' });
    expect(toSemanticNode({ id: 'n1', revision: '' }, decoration)).toMatchObject({
      states: { hidden: true },
      hiddenBy: 'aria-hidden',
    });
    expect(await readOne('link')).toMatchObject({ role: 'link', name: 'Good Ppl', states: { hidden: false }, hiddenBy: null });
    const { tree } = await capture();
    expect(flatten(tree).find((node) => node.role === 'link')).toMatchObject({ name: 'Good Ppl', testId: 'link' });
    expect((await walkedTestIds()).has('decoration')).toBe(false);
  });

  it('reads a layout-hidden node as hidden with no reason', async () => {
    await page.setContent(`
      <p data-testid="collapsed" style="display: none">Collapsed</p>
      <p data-testid="invisible" style="visibility: hidden">Invisible</p>
    `);
    for (const testId of ['collapsed', 'invisible']) {
      const raw = await readOne(testId);
      expect(raw, testId).toMatchObject({ states: { hidden: true }, hiddenBy: null });
      expect(toSemanticNode({ id: 'n1', revision: '' }, raw), testId).not.toHaveProperty('hiddenBy');
    }
    const walked = await walkedTestIds();
    expect(walked.has('collapsed')).toBe(false);
    expect(walked.has('invisible')).toBe(false);
  });
});

const text = (value: string, visible: boolean): Extract<LocatorExpression, { kind: 'query' }> => ({
  kind: 'query',
  query: { kind: 'text', value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
});

/** Depth-first walk of one observation tree. */
function* walk(node: SemanticNode): Generator<SemanticNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** One booted engine attempt on a fixture page, torn down whatever the body does. */
async function withPage(
  pathname: string,
  body: (engine: EngineHandle, operation: OperationContext) => Promise<void>,
): Promise<void> {
  const engine = web();
  const signal = new AbortController().signal;
  const operation: OperationContext = { signal, timeoutMs: 30_000, runId: 'run', attemptId: pathname, origin: 'test' };
  const cleanup = { signal, timeoutMs: 30_000 };
  await engine.init!({
    runId: 'run',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: {},
    headed: false,
    workerSlot: 0,
    log: () => undefined,
    signal,
  });
  try {
    await engine.startAttempt!({ attemptId: pathname, artifactsDir, signal, registerSecret: () => undefined });
    await engine.session!.open!(`${app.url}${pathname}`, operation);
    await body(engine, operation);
  } finally {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
  }
}

describe('visibility through the engine', () => {
  it('hides a match inside a frame the embedding document hides, for the boundary reason', async () => {
    await withPage('/frames', async (engine, operation) => {
      const inFrame = (selector: string, visible = false): LocatorExpression => ({
        kind: 'frame',
        selector,
        source: text('Save', visible),
      });
      const [ariaHidden] = await engine.locate!(inFrame('#hidden-frame'), operation);
      expect(ariaHidden).toMatchObject({ role: 'button', states: { hidden: true }, hiddenBy: 'aria-hidden' });
      const [collapsed] = await engine.locate!(inFrame('#collapsed-frame'), operation);
      expect(collapsed).toMatchObject({ role: 'button', states: { hidden: true } });
      expect(collapsed).not.toHaveProperty('hiddenBy');
      const [shown] = await engine.locate!(inFrame('#shown-frame'), operation);
      expect(shown?.role).toBe('button');
      expect(shown?.states?.hidden).toBeUndefined();
      // A visible query inside a hidden frame keeps nothing; inside the shown one, the match.
      expect(await engine.locate!(inFrame('#hidden-frame', true), operation)).toEqual([]);
      expect(await engine.locate!(inFrame('#shown-frame', true), operation)).toHaveLength(1);
      // The walk agrees: the hidden frames never enter the tree, and the one Save
      // button on the page hangs under the shown frame's boundary node.
      const snapshot = await engine.observe!(operation);
      const frames = [...walk(snapshot.root)].filter((node) => node.name?.endsWith(' frame'));
      expect(frames.map((node) => node.name)).toEqual(['Shown frame']);
      const saves = [...walk(snapshot.root)].filter((node) => node.role === 'button' && node.name === 'Save');
      expect(saves).toHaveLength(1);
      expect([...walk(frames[0]!)]).toContain(saves[0]);
    });
  });

  it('takes first() on a visible query among shown nodes when a hidden shadow host holds the first match', async () => {
    await withPage('/shadow-twins', async (engine, operation) => {
      const all = await engine.locate!(text('Save', false), operation);
      expect(all.map((node) => node.states?.hidden)).toEqual([true, undefined]);
      expect(all[0]?.hiddenBy).toBe('aria-hidden');
      const first = await engine.locate!({ kind: 'index', source: text('Save', true), index: 'first' }, operation);
      expect(first).toHaveLength(1);
      expect(first[0]?.states?.hidden).toBeUndefined();
      expect(await engine.locate!({ kind: 'index', source: text('Save', true), index: 0 }, operation)).toHaveLength(1);
      expect(await engine.locate!({ kind: 'index', source: text('Save', true), index: 1 }, operation)).toEqual([]);
      expect(await engine.locate!({ kind: 'index', source: text('Save', true), index: 'last' }, operation)).toHaveLength(1);
      // The surviving ref acts on the shown button.
      await engine.perform!(first[0]!.ref, { kind: 'tap' }, operation);
      expect(await engine.locate!(text('Saved', false), operation)).toHaveLength(1);
    });
  });
});
