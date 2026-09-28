/**
 * The playwright engine's lifecycle through the public contract: one shared
 * browser per engine, one context per attempt, and honest idempotent
 * teardown. No runner involved - the hooks are driven directly, the way the
 * attempt executor drives them.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  EngineCleanupContext,
  EngineHandle,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';

function cleanup(signal = new AbortController().signal): EngineCleanupContext {
  return { signal, timeoutMs: 30_000 };
}

function operation(attemptId: string, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-pool', attemptId, origin: 'test' };
}

function attempt(attemptId: string, artifactsDir: string) {
  return { attemptId, artifactsDir, signal: new AbortController().signal };
}

function byRole(role: string): LocatorExpression {
  return { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: role, exact: true } } };
}

/** Depth-first walk of one observation tree. */
function* walk(node: SemanticNode): Generator<SemanticNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** Runs one attempt on a booted engine and always tears it down. */
/**
 * Decodes a recording inside the page and reads its last frame: the frame's
 * size, how much of it is the grey a screencast pads a smaller frame with,
 * and how much of it is content.
 */
async function lastFrame(
  page: Page,
  webm: Buffer,
): Promise<{ width: number; height: number; padded: number; inked: number }> {
  return page.evaluate(async (bytes) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('the recording did not decode')), { once: true });
    });
    await video.play();
    await new Promise<void>((resolve) => {
      video.addEventListener('ended', () => resolve(), { once: true });
      setTimeout(resolve, 5_000);
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let padded = 0;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r === g && g === b && r > 120 && r < 136) padded += 1;
      else if (r < 200 || g < 200 || b < 200) inked += 1;
    }
    const total = data.length / 4;
    return { width: canvas.width, height: canvas.height, padded: padded / total, inked: inked / total };
  }, [...webm]);
}

async function withAttempt(
  engine: EngineHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
  body: () => Promise<void>,
): Promise<void> {
  await boot(engine, app);
  try {
    await engine.startAttempt!(attempt(attemptId, artifactsDir));
    await body();
  } finally {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }
}

async function boot(engine: EngineHandle, app: FixtureApp): Promise<void> {
  await engine.init!({
    runId: 'run-pool',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: {},
    headed: false,
    workerSlot: 0,
    log: () => undefined,
    signal: new AbortController().signal,
  });
}

async function openAttempt(
  engine: EngineHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
): Promise<string> {
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
  await engine.session!.open!(`${app.url}/`, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('web engine lifecycle', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-pool-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('declares the full deterministic tier plus the web fixture', () => {
    const engine = web();
    expect([...engine.capabilities].toSorted()).toEqual([
      'actions',
      'artifacts',
      'keyboard',
      'location',
      'observation',
      'pointer',
      'state',
      'web',
    ]);
    expect(engine.name).toBe('web');
  });

  it('serves consecutive attempts from one browser and survives an attempt close', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      expect(await openAttempt(engine, app, artifactsDir, 'a1')).toBe('Home');
      expect((await engine.observe!(operation('a1'))).location).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
      // The next attempt reuses the pooled browser process, not a new launch.
      expect(await openAttempt(engine, app, artifactsDir, 'a2')).toBe('Home');
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const engine = web();
    await boot(engine, app);
    await openAttempt(engine, app, artifactsDir, 'b1');
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await engine.dispose!(cleanup());

    await boot(engine, app);
    try {
      expect(await openAttempt(engine, app, artifactsDir, 'b2')).toBe('Home');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('observes a semantic tree and locates by display value in one round trip', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'd1', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/form`, operation('d1'));

      const snapshot = await engine.observe!(operation('d1'));
      expect(snapshot.root.ref.id).toBe('root');
      expect(snapshot.root.role).toBe('document');
      expect(snapshot.root.children?.length ?? 0).toBeGreaterThan(0);
      expect(snapshot.location).toBe(`${app.url}/form`);
      expect(snapshot.viewport).toEqual({ width: 1280, height: 720 });

      // displayValue is filtered from the values the batch read returned:
      // two inputs hold "alpha", one holds "beta".
      const alphas = await engine.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true } } },
        operation('d1'),
      );
      expect(alphas.map((node) => node.value)).toEqual(['alpha', 'alpha']);
      const betas = await engine.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'beta', exact: true } } },
        operation('d1'),
      );
      expect(betas).toHaveLength(1);
      // A single-match ref performs against the strict locator.
      await engine.perform!(betas[0]!.ref, { kind: 'fill', value: 'gamma', sensitive: false }, operation('d1'));
      const gammas = await engine.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'gamma', exact: true } } },
        operation('d1'),
      );
      expect(gammas.map((node) => node.name)).toEqual(['Second']);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('reports pressed and heading level, queries by them, and performs pointer actions on nodes and at points', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'pointer1', artifactsDir, signal: new AbortController().signal });
      const op = () => operation('pointer1');
      await engine.session!.open!(`${app.url}/pointer`, op());

      const snapshot = await engine.observe!(op());
      const nodes = [...walk(snapshot.root)];
      const heading = nodes.find((node) => node.role === 'heading');
      expect(heading).toMatchObject({ name: 'Pointer', level: 2 });
      expect(nodes.find((node) => node.name === 'Mute')?.states).toMatchObject({ pressed: false });
      expect(nodes.filter((node) => node.role !== 'heading').every((node) => node.level === undefined)).toBe(true);

      const heading2: LocatorExpression = {
        kind: 'query',
        query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 2 },
      };
      const heading1: LocatorExpression = {
        kind: 'query',
        query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 1 },
      };
      expect((await engine.locate!(heading2, op())).map((node) => node.name)).toEqual(['Pointer']);
      expect(await engine.locate!(heading1, op())).toEqual([]);

      const pressed = (value: boolean): LocatorExpression => ({
        kind: 'query',
        query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, states: { pressed: value } },
      });
      expect(await engine.locate!(pressed(true), op())).toEqual([]);
      const [mute] = await engine.locate!(pressed(false), op());
      await engine.perform!(mute!.ref, { kind: 'tap' }, op());
      expect((await engine.locate!(pressed(true), op())).map((node) => node.name)).toEqual(['Mute']);

      const [menuTarget] = await engine.locate!({ kind: 'selector', selector: '#menu-target' }, op());
      await engine.perform!(menuTarget!.ref, { kind: 'secondaryTap' }, op());
      const [afterMenu] = await engine.locate!({ kind: 'selector', selector: '#menu-target' }, op());
      expect(afterMenu?.text).toBe('context menu');

      // Every pointer kind at a bare point, read back from the page's event log.
      expect(engine.pointerActions).toEqual(['tap', 'doubleTap', 'secondaryTap', 'longPress', 'hover', 'dragTo', 'swipe', 'swipeTo']);
      await engine.performAt!({ x: 150, y: 350 }, { kind: 'tap' }, op());
      await engine.performAt!({ x: 160, y: 360 }, { kind: 'doubleTap' }, op());
      await engine.performAt!({ x: 170, y: 370 }, { kind: 'secondaryTap' }, op());
      await engine.performAt!({ x: 180, y: 380 }, { kind: 'longPress', durationMs: 120 }, op());
      await engine.performAt!({ x: 190, y: 390 }, { kind: 'hover' }, op());
      await engine.performAt!({ x: 200, y: 400 }, { kind: 'dragTo', target: { x: 300, y: 450 } }, op());
      await engine.performAt!({ x: 210, y: 410 }, { kind: 'swipe', direction: 'down' }, op());
      // A fractional path lands on whole pixels: the browser would truncate it a pixel early.
      await engine.performAt!({ x: 220.6, y: 420.4 }, { kind: 'swipeTo', target: { x: 320.5, y: 460.5 } }, op());
      const [log] = await engine.locate!({ kind: 'selector', selector: '#log' }, op());
      const lines = (log?.text ?? '').split('\n').filter((line) => line !== '');
      expect(lines).toContain('click:150,350');
      expect(lines.filter((line) => line.startsWith('dblclick:'))).toEqual(['dblclick:160,360']);
      expect(lines).toContain('contextmenu:170,370');
      expect(lines).toContain('mousedown:180,380');
      expect(lines).toContain('mouseup:180,380');
      expect(lines).toContain('mousedown:200,400');
      expect(lines).toContain('mouseup:300,450');
      expect(lines.some((line) => line.startsWith('wheel:210,410:') && Number(line.split(':')[2]) > 0)).toBe(true);
      expect(lines).toContain('mousedown:221,420');
      expect(lines).toContain('mouseup:321,461');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('keeps tree attributes bounded while node reads expose every attribute', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'attributes1', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/`, operation('attributes1'));

      const snapshot = await engine.observe!(operation('attributes1'));
      const treeNodes = [...walk(snapshot.root)];
      expect(treeNodes.some((node) => node.attributes?.class === 'card active')).toBe(false);
      expect(treeNodes.some((node) => node.attributes?.readonly !== undefined)).toBe(false);
      expect(treeNodes.some((node) => node.attributes?.['data-extra'] !== undefined)).toBe(false);

      const [card] = await engine.locate!(
        { kind: 'selector', selector: '#class-card' },
        operation('attributes1'),
      );
      expect(card?.attributes).toMatchObject({
        class: 'card active',
        'data-extra': 'node-only',
      });
      expect(card?.attributes?.readonly).toBeUndefined();
      const [readonly] = await engine.locate!(
        { kind: 'selector', selector: '#readonly' },
        operation('attributes1'),
      );
      expect(readonly?.attributes?.readonly).toBe('');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('selects positionally among display-value matches and keeps composition honest', async () => {
    const engine = web();
    const shared: LocatorExpression = {
      kind: 'query',
      query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
    };
    const names = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.name);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'dv1', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/values`, operation('dv1'));

      // Positions are relative to the value-filtered matches, not to every
      // form control on the page: "Other" sits between none of them.
      expect(names(await engine.locate!(shared, operation('dv1')))).toEqual(['First', 'Second', 'Third']);
      expect(names(await engine.locate!({ kind: 'index', source: shared, index: 'first' }, operation('dv1')))).toEqual(['First']);
      expect(names(await engine.locate!({ kind: 'index', source: shared, index: 1 }, operation('dv1')))).toEqual(['Second']);
      expect(names(await engine.locate!({ kind: 'index', source: shared, index: 'last' }, operation('dv1')))).toEqual(['Third']);
      expect(await engine.locate!({ kind: 'index', source: shared, index: 3 }, operation('dv1'))).toEqual([]);

      // Positions chain innermost first: first() of last() is still the last match.
      const firstOfLast = await engine.locate!(
        { kind: 'index', source: { kind: 'index', source: shared, index: 'last' }, index: 'first' },
        operation('dv1'),
      );
      expect(names(firstOfLast)).toEqual(['Third']);

      // filter({ hasText }) composes as a per-element Playwright filter ahead of
      // the value predicate. Inputs have no text content; the textarea's is its
      // initial content, exactly as for any other query.
      const withText = await engine.locate!(
        { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'shared', exact: false } },
        operation('dv1'),
      );
      expect(names(withText)).toEqual(['Third']);
      expect(
        await engine.locate!(
          { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'nowhere', exact: false } },
          operation('dv1'),
        ),
      ).toEqual([]);

      // A filter after a position is checked on the selected element alone:
      // the last match is the textarea, whose text content is "shared"; the
      // first is an input with no text content at all.
      const lastWithText = await engine.locate!(
        {
          kind: 'filter',
          source: { kind: 'index', source: shared, index: 'last' },
          hasText: { kind: 'string', value: 'shared', exact: false },
        },
        operation('dv1'),
      );
      expect(names(lastWithText)).toEqual(['Third']);
      expect(
        await engine.locate!(
          {
            kind: 'filter',
            source: { kind: 'index', source: shared, index: 'first' },
            hasText: { kind: 'string', value: 'shared', exact: false },
          },
          operation('dv1'),
        ),
      ).toEqual([]);
      // ... and `has` on a positional match too; a form control has no
      // descendant nodes, so nothing survives.
      expect(
        await engine.locate!(
          { kind: 'filter', source: { kind: 'index', source: shared, index: 'last' }, has: byRole('textbox') },
          operation('dv1'),
        ),
      ).toEqual([]);

      // The ref a positional match hands back acts on that element alone.
      const [last] = await engine.locate!({ kind: 'index', source: shared, index: 'last' }, operation('dv1'));
      await engine.perform!(last!.ref, { kind: 'fill', value: 'edited', sensitive: false }, operation('dv1'));
      expect(names(await engine.locate!(shared, operation('dv1')))).toEqual(['First', 'Second']);
      const edited: LocatorExpression = {
        kind: 'query',
        query: { kind: 'displayValue', value: { kind: 'string', value: 'edited', exact: true } },
      };
      expect(names(await engine.locate!(edited, operation('dv1')))).toEqual(['Third']);

      // What still needs the value predicate inside Playwright's chain stays
      // unsupported, and says which compositions those are.
      const child: LocatorExpression = {
        kind: 'query',
        query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
        scope: shared,
      };
      await expect(engine.locate!(child, operation('dv1'))).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'displayValue queries cannot scope child queries or serve as a has-filter in this engine',
      });
      await expect(
        engine.locate!({ kind: 'filter', source: byRole('main'), has: shared }, operation('dv1')),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('excludes hidden twins from a visible query, for every query kind and under an index', async () => {
    const engine = web();
    const query = (
      kind: 'text' | 'label' | 'placeholder' | 'displayValue' | 'testId' | 'role',
      value: string,
      visible: boolean,
    ): LocatorExpression => ({
      kind: 'query',
      query: { kind, value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
    });
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'v1', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/twins`, operation('v1'));

      const twins: Array<[Parameters<typeof query>[0], string]> = [
        ['text', 'No memories yet'],
        ['label', 'Memory search'],
        ['placeholder', 'Search memory...'],
        ['displayValue', 'alpha'],
        ['testId', 'memory-empty'],
      ];
      for (const [kind, value] of twins) {
        const all = await engine.locate!(query(kind, value, false), operation('v1'));
        expect(all.map((node) => node.states?.hidden === true), `${kind} without visible`).toEqual([true, false]);
        const shown = await engine.locate!(query(kind, value, true), operation('v1'));
        expect(shown, `${kind} with visible`).toHaveLength(1);
        expect(shown[0]?.states?.hidden).toBeUndefined();
        expect(shown[0]?.rect?.width ?? 0).toBeGreaterThan(0);
      }

      // A role query already skips display:none; visible leaves it alone: the twin's shown
      // button, the labeled button, and the insert button below, never the hidden twin.
      expect(await engine.locate!(query('role', 'button', true), operation('v1'))).toHaveLength(3);

      // A required-field marker is aria-hidden: the label names the field without it.
      const required = await engine.locate!(query('label', 'Display name', false), operation('v1'));
      expect(required).toHaveLength(1);
      expect(required[0]?.name).toBe('Display name');
      // Hidden text between visible fragments is skipped too, and CSS-hidden text stays out.
      const infix = await engine.locate!(query('label', 'Team name', false), operation('v1'));
      expect(infix.map((node) => node.name)).toEqual(['Team name']);
      const mixed = await engine.locate!(query('label', 'Mixed', false), operation('v1'));
      expect(mixed.map((node) => node.name)).toEqual(['Mixed']);
      // Any associated label matches, as getByLabel promises: an overridden one and a second one.
      expect(await engine.locate!(query('label', 'Visible label', false), operation('v1'))).toHaveLength(1);
      expect(await engine.locate!(query('label', 'Second label', false), operation('v1'))).toHaveLength(1);
      expect(await engine.locate!(query('label', 'First label', false), operation('v1'))).toHaveLength(1);
      // Every labelable element carries its labels: a button and a meter too, not only text fields.
      const labeledButton = await engine.locate!(query('label', 'Run the check', false), operation('v1'));
      expect(labeledButton.map((node) => node.role)).toEqual(['button']);
      expect(await engine.locate!(query('label', 'Score', false), operation('v1'))).toHaveLength(1);
      // The marker is still on the screen a person reads: the label's own text keeps it.
      expect(await engine.locate!(query('text', 'Display name*', false), operation('v1'))).toHaveLength(1);

      // A predicate-filtered match is pinned to its element: a field inserted ahead of it
      // between locate and perform shifts every candidate index, and the fill still lands on
      // the field that matched.
      const displayName = (await engine.locate!(query('label', 'Display name', false), operation('v1')))[0]!;
      const insert = (await engine.locate!(query('role', 'button', false), operation('v1'))).find(
        (node) => node.name === 'Insert a field',
      )!;
      await engine.perform!(insert.ref, { kind: 'tap' }, operation('v1'));
      await engine.perform!(displayName.ref, { kind: 'fill', value: 'pinned', sensitive: false }, operation('v1'));
      const after = await engine.locate!(query('label', 'Display name', false), operation('v1'));
      expect(after.map((node) => node.value)).toEqual(['pinned']);
      const inserted = await engine.locate!(query('label', 'Inserted', false), operation('v1'));
      expect(inserted.map((node) => node.value ?? '')).toEqual(['']);

      // aria-hidden is invisible to Playwright's own filter; the node's hidden state still excludes it.
      expect(await engine.locate!(query('text', 'Decorative twin', false), operation('v1'))).toHaveLength(2);
      const decorative = await engine.locate!(query('text', 'Decorative twin', true), operation('v1'));
      expect(decorative).toHaveLength(1);
      expect(decorative[0]?.attributes?.['aria-hidden']).toBeUndefined();

      // Under an index the predicate runs before nth: first() is the first shown node, not the first node.
      const firstAny = await engine.locate!(
        { kind: 'index', source: query('text', 'No memories yet', false), index: 'first' },
        operation('v1'),
      );
      expect(firstAny.map((node) => node.states?.hidden)).toEqual([true]);
      const firstShown = await engine.locate!(
        { kind: 'index', source: query('text', 'No memories yet', true), index: 'first' },
        operation('v1'),
      );
      expect(firstShown).toHaveLength(1);
      expect(firstShown[0]?.states?.hidden).toBeUndefined();

      // The surviving ref acts on the shown element.
      const [search] = await engine.locate!(query('placeholder', 'Search memory...', true), operation('v1'));
      await engine.perform!(search!.ref, { kind: 'fill', value: 'launch', sensitive: false }, operation('v1'));
      const filled = await engine.locate!(query('displayValue', 'launch', false), operation('v1'));
      expect(filled.map((node) => node.states?.hidden)).toEqual([undefined]);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('applies visible before an index, filter, or scope, so an aria-hidden twin is never selected', async () => {
    const engine = web();
    const text = (value: string, visible: boolean): Extract<LocatorExpression, { kind: 'query' }> => ({
      kind: 'query',
      query: { kind: 'text', value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
    });
    const ariaHidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.attributes?.['aria-hidden']);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'v2', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/twins`, operation('v2'));
      const locate = (expression: LocatorExpression) => engine.locate!(expression, operation('v2'));

      // The aria-hidden paragraph comes first in document order.
      expect(ariaHidden(await locate({ kind: 'index', source: text('Decorative twin', false), index: 'first' }))).toEqual(['true']);
      expect(ariaHidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 'first' }))).toEqual([undefined]);
      expect(ariaHidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 0 }))).toEqual([undefined]);
      expect(await locate({ kind: 'index', source: text('Decorative twin', true), index: 1 })).toEqual([]);
      expect(ariaHidden(await locate({ kind: 'index', source: text('Decorative twin', true), index: 'last' }))).toEqual([undefined]);

      // A filter over a visible query never retains the hidden twin.
      const decorative = { kind: 'string', value: 'Decorative', exact: false } as const;
      expect(await locate({ kind: 'filter', source: text('Decorative twin', false), hasText: decorative })).toHaveLength(2);
      const filtered = await locate({ kind: 'filter', source: text('Decorative twin', true), hasText: decorative });
      expect(ariaHidden(filtered)).toEqual([undefined]);

      // As a has-filter, only the shown twin's ancestor qualifies: the body holds both, so it still matches,
      // while a section that holds neither does not.
      const body: LocatorExpression = { kind: 'selector', selector: 'body' };
      expect(await locate({ kind: 'filter', source: body, has: text('Decorative twin', true) })).toHaveLength(1);
      expect(await locate({ kind: 'filter', source: { kind: 'selector', selector: '#live' }, has: text('Decorative twin', true) })).toEqual([]);

      // As a scope, a visible test-id query drops the aria-hidden panel before the child query runs.
      const panel = (visible: boolean): LocatorExpression => ({
        kind: 'query',
        query: { kind: 'testId', value: { kind: 'string', value: 'memory-panel', exact: true }, ...(visible ? { visible: true } : {}) },
      });
      expect(await locate({ ...text('Open', false), scope: panel(false) })).toHaveLength(2);
      const scoped = await locate({ ...text('Open', false), scope: panel(true) });
      expect(scoped).toHaveLength(1);
      // The child itself carries no aria-hidden; its exclusion came from the scope.
      const panels = await locate(panel(true));
      expect(ariaHidden(panels)).toEqual([undefined]);
      await engine.perform!(scoped[0]!.ref, { kind: 'tap' }, operation('v2'));
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('takes a display-value position among shown matches when the query is visible', async () => {
    const engine = web();
    const alpha = (visible: boolean): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true }, ...(visible ? { visible: true } : {}) },
    });
    const hidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.states?.hidden);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'dv2', artifactsDir, signal: new AbortController().signal });
      await engine.session!.open!(`${app.url}/twins`, operation('dv2'));
      const locate = (expression: LocatorExpression) => engine.locate!(expression, operation('dv2'));

      // The display:none control comes first in document order, so without
      // visible the first position is the hidden twin.
      expect(hidden(await locate({ kind: 'index', source: alpha(false), index: 'first' }))).toEqual([true]);
      expect(hidden(await locate({ kind: 'index', source: alpha(false), index: 1 }))).toEqual([undefined]);

      // With visible, hidden candidates leave before the value predicate and
      // its positional steps run, so every position is among shown controls.
      expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 'first' }))).toEqual([undefined]);
      expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 0 }))).toEqual([undefined]);
      expect(hidden(await locate({ kind: 'index', source: alpha(true), index: 'last' }))).toEqual([undefined]);
      expect(await locate({ kind: 'index', source: alpha(true), index: 1 })).toEqual([]);

      // A filter after the position runs on the shown element alone.
      const filtered = await locate({
        kind: 'filter',
        source: { kind: 'index', source: alpha(true), index: 'first' },
        hasText: { kind: 'string', value: 'nothing here', exact: false },
      });
      expect(filtered).toEqual([]);

      // The positional ref acts on the shown control, and the hidden twin keeps its value.
      const [first] = await locate({ kind: 'index', source: alpha(true), index: 'first' });
      await engine.perform!(first!.ref, { kind: 'fill', value: 'launch', sensitive: false }, operation('dv2'));
      expect(hidden(await locate(alpha(false)))).toEqual([true]);
      expect(
        hidden(await locate({ kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'launch', exact: true } } })),
      ).toEqual([undefined]);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('reports an unopened page as INVALID_STATE, never as a missing node', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal });
      await expect(engine.observe!(operation('c1'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('refuses a second startAttempt while one is running and keeps the first intact', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'e1', async () => {
      await expect(engine.startAttempt!(attempt('e2', artifactsDir))).rejects.toMatchObject({
        code: 'INVALID_STATE',
        retryable: false,
      });
      await engine.session!.open!(`${app.url}/`, operation('e1'));
      expect((await engine.observe!(operation('e1'))).location).toBe(`${app.url}/`);
    });
  });

  it('treats endAttempt before startAttempt and dispose on a cold engine as no-ops', async () => {
    const cold = web();
    await expect(cold.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(cold.dispose!(cleanup())).resolves.toBeUndefined();

    const engine = web();
    try {
      await boot(engine, app);
      await expect(engine.endAttempt!(cleanup())).resolves.toBeUndefined();
      expect(await openAttempt(engine, app, artifactsDir, 'f1')).toBe('Home');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('stops waiting on cleanup once its budget is aborted, and recovers on the next attempt', async () => {
    const engine = web();
    try {
      await boot(engine, app);
      expect(await openAttempt(engine, app, artifactsDir, 'g1')).toBe('Home');
      const exhausted = new AbortController();
      exhausted.abort();
      await expect(engine.endAttempt!({ signal: exhausted.signal, timeoutMs: 0 })).resolves.toBeUndefined();
      expect(await openAttempt(engine, app, artifactsDir, 'g2')).toBe('Home');
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  });

  it('cancels an in-flight operation when its signal aborts instead of waiting out Playwright', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'h1', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = engine.session!.open!(`${app.url}/slow`, operation('h1', controller.signal));
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it('round-trips persisted state through capture and restore, and reset drops it', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 's1', async () => {
      const token = async (): Promise<string> => {
        const [heading] = await engine.locate!(byRole('heading'), operation('s1'));
        return heading?.name ?? '';
      };
      await engine.session!.open!(`${app.url}/state?set=abc`, operation('s1'));
      expect(await token()).toBe('abc');
      const state = await engine.state!.capture(operation('s1'));
      expect(state.format).toBe('playwright-storage-state');

      await engine.session!.reset!(operation('s1'));
      await engine.session!.open!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('none');

      await engine.state!.restore(state, operation('s1'));
      await engine.session!.open!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('abc');

      // A restart keeps the persisted state and shows nothing until the harness reopens the app.
      await engine.session!.restart!(operation('s1'));
      expect(surfaceOf(engine)!.page().url()).toBe('about:blank');
      expect((await engine.observe!(operation('s1'))).location).toBe('about:blank');
      await engine.session!.open!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('abc');

      await expect(
        engine.state!.restore({ format: 'playwright-storage-state', version: 1, data: '/etc/passwd' }, operation('s1')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
  });

  it('keeps a node id across observations while its element lives, and reports it stale once it is gone', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'o1', async () => {
      await engine.session!.open!(`${app.url}/form`, operation('o1'));
      const first = await engine.observe!(operation('o1'));
      const textbox = [...walk(first.root)].find((node) => node.role === 'textbox');
      expect(textbox).toBeDefined();
      await engine.perform!(textbox!.ref, { kind: 'fill', value: 'fresh', sensitive: false }, operation('o1'));

      // The id is stamped on the element: a second look names the same
      // textbox by the same id, and the earlier ref still acts on it.
      const second = await engine.observe!(operation('o1'));
      const again = [...walk(second.root)].find((node) => node.role === 'textbox');
      expect(again!.ref.id).toBe(textbox!.ref.id);
      await engine.perform!(textbox!.ref, { kind: 'fill', value: 'late', sensitive: false }, operation('o1'));

      // A new document has none of the old elements: the id is gone with it.
      await engine.session!.open!(`${app.url}/`, operation('o1'));
      const third = await engine.observe!(operation('o1'));
      expect([...walk(third.root)].some((node) => node.ref.id === textbox!.ref.id)).toBe(false);
      await expect(
        engine.perform!(textbox!.ref, { kind: 'fill', value: 'gone', sensitive: false }, operation('o1')),
      ).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    });
  });

  it('mints one root id that survives navigation, and swipes the viewport when it is the target', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'r1', async () => {
      await engine.session!.open!(`${app.url}/form`, operation('r1'));
      const first = await engine.observe!(operation('r1'));
      expect(first.root.ref.id).toBe('root');
      expect(first.root.name).toBe('Fixture Form');
      // The element ids under the root are stamped in the page; the root's is the engine's.
      expect([...walk(first.root)].slice(1).every((node) => /^n\d+$/.test(node.ref.id))).toBe(true);

      // A new document stamps new numbers; the root keeps its id.
      await engine.session!.open!(`${app.url}/`, operation('r1'));
      const second = await engine.observe!(operation('r1'));
      expect(second.root.ref.id).toBe('root');
      expect(second.root.name).toBe('Fixture Home');
      expect(second.location).toBe(`${app.url}/`);

      // The viewport swipe arrives as a swipe on the root, addressed from an earlier observation.
      const page = surfaceOf(engine)!.page();
      await page.setContent('<div style="height: 5000px">tall</div>');
      await engine.perform!(first.root.ref, { kind: 'swipe', direction: 'down' }, operation('r1'));
      await page.waitForFunction(() => window.scrollY > 0);
      expect(await page.evaluate(() => window.scrollY)).toBe(360);
      await engine.perform!(first.root.ref, { kind: 'swipe', direction: 'up', momentum: 'fast' }, operation('r1'));
      await page.waitForFunction(() => window.scrollY === 0);
    });
  });

  it('follows the window under viewport: null, reports the measured size, and swipes by it', async () => {
    const engine = web({ viewport: null });
    await withAttempt(engine, app, artifactsDir, 'w1', async () => {
      await engine.session!.open!(`${app.url}/form`, operation('w1'));
      const page = surfaceOf(engine)!.page();
      expect(page.viewportSize()).toBeNull();
      const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(measured.width).toBeGreaterThan(0);
      const snapshot = await engine.observe!(operation('w1'), { pixels: true });
      expect(snapshot.viewport).toEqual(measured);
      expect(snapshot.pixels).toBeDefined();

      await page.setContent('<div style="height: 5000px">tall</div>');
      await engine.perform!(snapshot.root.ref, { kind: 'swipe', direction: 'down' }, operation('w1'));
      await page.waitForFunction(() => window.scrollY > 0);
      expect(await page.evaluate(() => window.scrollY)).toBe(Math.round(measured.height / 2));
    });
  });

  it('reports the configured test-id attribute as testId, on observed and located nodes alike', async () => {
    const engine = web({ testIdAttribute: 'data-qa' });
    const byTestId = (value: string): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'testId', value: { kind: 'string', value, exact: true } },
    });
    await withAttempt(engine, app, artifactsDir, 'tid1', async () => {
      await engine.session!.open!(`${app.url}/`, operation('tid1'));
      await surfaceOf(engine)!.page().setContent(
        '<button data-qa="go">Go</button><button data-testid="stop">Stop</button>',
      );
      const observed = [...walk((await engine.observe!(operation('tid1'))).root)];
      const go = observed.find((node) => node.name === 'Go');
      const stop = observed.find((node) => node.name === 'Stop');
      expect(go?.testId).toBe('go');
      expect(stop?.testId).toBeUndefined();
      // The tree carries the id as a field, not as an attribute.
      expect(go?.attributes?.['data-qa']).toBeUndefined();

      const located = await engine.locate!(byTestId('go'), operation('tid1'));
      expect(located.map((node) => node.testId)).toEqual(['go']);
      expect(await engine.locate!(byTestId('stop'), operation('tid1'))).toEqual([]);
    });
  });

  it('observes, locates, and acts inside a closed shadow root, which Playwright alone cannot reach', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'cs1', async () => {
      await engine.session!.open!(`${app.url}/closed-shadow`, operation('cs1'));
      // A role query searches the closed root the reader also walks, so the
      // tree and the locator name the same control.
      const located = await engine.locate!(byRole('button'), operation('cs1'));
      expect(located.map((node) => node.name)).toEqual(['Checkout']);

      const snapshot = await engine.observe!(operation('cs1'));
      const checkout = [...walk(snapshot.root)].find((node) => node.role === 'button');
      expect(checkout?.name).toBe('Checkout');

      await engine.perform!(checkout!.ref, { kind: 'tap' }, operation('cs1'));
      const headings = await engine.locate!(byRole('heading'), operation('cs1'));
      expect(headings.map((node) => node.name)).toEqual(['Checked out']);
    });
  });

  it('walks through a display:contents element to the fields it lays out', async () => {
    const engine = web();
    await withAttempt(engine, app, artifactsDir, 'dc1', async () => {
      await engine.session!.open!(`${app.url}/contents`, operation('dc1'));
      const snapshot = await engine.observe!(operation('dc1'));
      const fields = [...walk(snapshot.root)].filter((node) => node.role === 'textbox').map((node) => node.name);
      expect(fields).toEqual(['Email', 'First name']);
    });
  });

  it('masks a password inside a closed shadow root in artifact screenshots', async () => {
    const engine = web();
    const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
    try {
      await boot(engine, app);
      await engine.startAttempt!(attempt('cm1', shotDir));
      await engine.session!.open!(`${app.url}/closed-login`, operation('cm1'));
      const snapshot = await engine.observe!(operation('cm1'));
      const nodes = [...walk(snapshot.root)];
      const user = nodes.find((node) => node.role === 'textbox' && node.name === 'User');
      const password = nodes.find((node) => node.states?.secure === true);
      expect(user?.rect).toBeDefined();
      expect(password?.rect).toBeDefined();
      await engine.perform!(password!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, operation('cm1'));

      const relative = await engine.artifacts!.screenshot('closed', operation('cm1'));
      const image = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
      const centre = (rect: NonNullable<SemanticNode['rect']>) =>
        [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] as const;
      const [px, py] = centre(password!.rect!);
      const [ux, uy] = centre(user!.rect!);
      expect(image.pixelAt(px, py).slice(0, 3)).toEqual([0, 0, 0]);
      expect(image.pixelAt(ux, uy).slice(0, 3)).toEqual([255, 255, 255]);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
      rmSync(shotDir, { recursive: true, force: true });
    }
  });

  it('keeps tracing across reset: the earlier segment is kept and the trace still stops', async () => {
    const engine = web();
    const traceDir = mkdtempSync(path.join(tmpdir(), 'e2e-trace-'));
    try {
      await withAttempt(engine, app, traceDir, 't1', async () => {
        await engine.artifacts!.startTrace!(operation('t1'));
        await engine.session!.open!(`${app.url}/`, operation('t1'));
        await engine.session!.reset!(operation('t1'));
        await engine.session!.open!(`${app.url}/form`, operation('t1'));
        const archives = await engine.artifacts!.stopTrace!(operation('t1'));
        // The segment closed at reset comes first, then the final archive.
        expect(archives).toEqual(['trace/trace-part1.zip', 'trace/trace.zip']);
        for (const file of archives as readonly string[]) {
          const absolute = path.join(traceDir, file);
          expect(existsSync(absolute), file).toBe(true);
          expect(statSync(absolute).size).toBeGreaterThan(0);
          expect(readFileSync(absolute).subarray(0, 2).toString('latin1')).toBe('PK');
        }
      });
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it('records a video per page at the viewport size: a restart and a state reset each continue in a new segment', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    const nodesOf = (snapshot: { root: SemanticNode }) => [...walk(snapshot.root)];
    const painted = new WeakSet<Page>();
    const restores: (() => void)[] = [];
    /** Observe the same delivered frames the recorder writes, including on replacement pages. */
    const watchPage = (page: Page): void => {
      const start = page.screencast.start.bind(page.screencast);
      const spy = vi.spyOn(page.screencast, 'start').mockImplementation((options) => start({
        ...options,
        onFrame: async (frame) => {
          const hasPaint = await page.evaluate(async (bytes) => {
            const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            for (let index = 0; index < data.length; index += 4) {
              if (data[index]! < 200 || data[index + 1]! < 200 || data[index + 2]! < 200) return true;
            }
            return false;
          }, [...frame.data]).catch(() => false);
          if (hasPaint) painted.add(page);
          await options?.onFrame?.(frame);
        },
      }));
      restores.push(() => spy.mockRestore());
    };
    /** Install the frame observer before a newly created page starts its recording. */
    const watchContext = (context: BrowserContext): void => {
      context.on('page', watchPage);
      for (const page of context.pages()) watchPage(page);
    };
    const settle = async (): Promise<void> => {
      const page = surfaceOf(engine)!.page();
      // A static page may not repaint after navigation overtakes its first screencast frame.
      await page.screenshot();
      await expect.poll(() => painted.has(page), { timeout: 5_000, message: 'the recorder received a painted frame' }).toBe(true);
    };
    try {
      await withAttempt(engine, app, videoDir, 'v1', async () => {
        await engine.session!.open!(`${app.url}/form`, operation('v1'));
        const context = surfaceOf(engine)!.context();
        watchContext(context);
        const browser = context.browser()!;
        const newContext = browser.newContext.bind(browser);
        const contextSpy = vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
          const next = await newContext(options);
          watchContext(next);
          return next;
        });
        restores.push(() => contextSpy.mockRestore());
        // Video before trace, as the harness orders them: a page's first
        // screencast client sizes it, and the trace's would cap it at 800px.
        await engine.artifacts!.startVideo!(operation('v1'));
        await engine.artifacts!.startTrace!(operation('v1'));
        const page = surfaceOf(engine)!.page();
        const viewport = page.viewportSize()!;
        // Observations, actions, and captures run as they would without a recording.
        const observed = nodesOf(await engine.observe!(operation('v1'), { pixels: true }));
        const textbox = observed.find((node) => node.role === 'textbox' && node.name === 'First');
        await engine.perform!(textbox!.ref, { kind: 'fill', value: 'recorded', sensitive: false }, operation('v1'));
        await engine.artifacts!.screenshot('shot', operation('v1'));
        await settle();
        // A restart closes the page and opens another, blank until the harness
        // reopens the app: the recording continues in a second segment.
        await engine.session!.restart!(operation('v1'));
        expect(surfaceOf(engine)!.page()).not.toBe(page);
        expect(surfaceOf(engine)!.page().url()).toBe('about:blank');
        await engine.session!.open!(`${app.url}/form`, operation('v1'));
        await settle();
        // A state reset recreates the context; the recording continues in a third.
        await engine.session!.reset!(operation('v1'));
        expect(surfaceOf(engine)!.page().url()).toBe('about:blank');
        await engine.session!.open!(`${app.url}/`, operation('v1'));
        await settle();
        const segments = await engine.artifacts!.stopVideo!(operation('v1'));
        // The restart and the state reset each closed a trace segment before the final archive.
        expect(await engine.artifacts!.stopTrace!(operation('v1'))).toEqual([
          'trace/trace-part1.zip',
          'trace/trace-part2.zip',
          'trace/trace.zip',
        ]);
        expect(segments.map((segment) => segment.path)).toEqual([
          'video/video.webm',
          'video/video-part2.webm',
          'video/video-part3.webm',
        ]);
        const viewer = surfaceOf(engine)!.page();
        for (const segment of segments) {
          const absolute = path.join(videoDir, segment.path);
          expect(existsSync(absolute), segment.path).toBe(true);
          expect(statSync(absolute).size).toBeGreaterThan(0);
          // Every WebM file opens with the EBML magic.
          expect(readFileSync(absolute).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
          expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
          // Every segment shows the page at the attempt's viewport size: no
          // grey padding from a screencast another client sized smaller, and
          // some ink, so the page painted into it.
          const frame = await lastFrame(viewer, readFileSync(absolute));
          expect({ width: frame.width, height: frame.height }, segment.path).toEqual(viewport);
          expect(frame.padded, `${segment.path} padded`).toBeLessThan(0.01);
          expect(frame.inked, `${segment.path} inked`).toBeGreaterThan(0.0005);
        }
      });
    } finally {
      for (const restore of restores) restore();
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('splits a running trace around a video started mid-attempt, so every recording fills the viewport', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    try {
      await withAttempt(engine, app, videoDir, 'v3', async () => {
        // A host that records on demand: the trace already sized the screencast when the video starts.
        await engine.artifacts!.startTrace!(operation('v3'));
        await engine.session!.open!(`${app.url}/`, operation('v3'));
        const viewer = surfaceOf(engine)!.page();
        const viewport = viewer.viewportSize()!;
        const segments = [];
        for (const url of [`${app.url}/form`, `${app.url}/`]) {
          await engine.artifacts!.startVideo!(operation('v3'));
          await engine.session!.open!(url, operation('v3'));
          await viewer.screenshot();
          segments.push(...(await engine.artifacts!.stopVideo!(operation('v3'))));
        }
        expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm']);
        for (const segment of segments) {
          const frame = await lastFrame(viewer, readFileSync(path.join(videoDir, segment.path)));
          expect({ width: frame.width, height: frame.height }, segment.path).toEqual(viewport);
          expect(frame.padded, `${segment.path} padded`).toBeLessThan(0.01);
        }
        // Each start closed the trace segment before it; the trace kept running around both.
        expect(await engine.artifacts!.stopTrace!(operation('v3'))).toEqual([
          'trace/trace-part1.zip',
          'trace/trace-part2.zip',
          'trace/trace.zip',
        ]);
      });
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('resumes the trace a mid-attempt video start split, even when the video cannot start', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    try {
      await withAttempt(engine, app, videoDir, 'v4', async () => {
        await engine.artifacts!.startTrace!(operation('v4'));
        await engine.session!.open!(`${app.url}/`, operation('v4'));
        const page = surfaceOf(engine)!.page();
        const spy = vi.spyOn(page.screencast, 'start').mockRejectedValueOnce(new Error('screencast unavailable'));
        try {
          await expect(engine.artifacts!.startVideo!(operation('v4'))).rejects.toThrow('screencast unavailable');
        } finally {
          spy.mockRestore();
        }
        await engine.session!.open!(`${app.url}/form`, operation('v4'));
        // The segment before the failed start, then the one that kept tracing after it.
        expect(await engine.artifacts!.stopTrace!(operation('v4'))).toEqual(['trace/trace-part1.zip', 'trace/trace.zip']);
      });
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('opens the attempt page when the video starts, so a trace started after it records at the video size', async () => {
    const engine = web();
    const videoDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-'));
    try {
      await withAttempt(engine, app, videoDir, 'v2', async () => {
        await engine.artifacts!.startVideo!(operation('v2'));
        // The page exists before any navigation: the recording owns its screencast.
        expect(surfaceOf(engine)!.page().url()).toBe('about:blank');
        await engine.artifacts!.startTrace!(operation('v2'));
        await engine.session!.open!(`${app.url}/`, operation('v2'));
        const segments = await engine.artifacts!.stopVideo!(operation('v2'));
        expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm']);
        expect(await engine.artifacts!.stopTrace!(operation('v2'))).toBe('trace/trace.zip');
        expect(statSync(path.join(videoDir, 'video/video.webm')).size).toBeGreaterThan(0);
      });
    } finally {
      rmSync(videoDir, { recursive: true, force: true });
    }
  });

  it('masks secure fields in artifact screenshots and restarts the counter per attempt', async () => {
    const engine = web();
    const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
    try {
      await boot(engine, app);
      await engine.startAttempt!(attempt('m1', shotDir));
      await engine.session!.open!(`${app.url}/login`, operation('m1'));
      expect(await engine.artifacts!.screenshot('first', operation('m1'))).toBe('screenshots/001-first.png');
      await engine.endAttempt!(cleanup());

      await engine.startAttempt!(attempt('m2', shotDir));
      await engine.session!.open!(`${app.url}/login`, operation('m2'));
      const nodes = await engine.locate!(byRole('textbox'), operation('m2'));
      const user = nodes.find((node) => node.name === 'User');
      expect(user?.rect).toBeDefined();
      const [password] = await engine.locate!({ kind: 'selector', selector: 'input[type=password]' }, operation('m2'));
      expect(password?.rect).toBeDefined();
      await engine.perform!(password!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, operation('m2'));

      const relative = await engine.artifacts!.screenshot('login', operation('m2'));
      expect(relative).toBe('screenshots/001-login.png');
      const image = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
      const centre = (rect: NonNullable<SemanticNode['rect']>) =>
        [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] as const;
      const [px, py] = centre(password!.rect!);
      const [ux, uy] = centre(user!.rect!);
      // The password field is covered by the opaque mask; the plain field is not.
      expect(image.pixelAt(px, py).slice(0, 3)).toEqual([0, 0, 0]);
      expect(image.pixelAt(ux, uy).slice(0, 3)).toEqual([255, 255, 255]);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
      rmSync(shotDir, { recursive: true, force: true });
    }
  });
});
