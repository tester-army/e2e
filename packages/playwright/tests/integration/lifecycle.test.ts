/**
 * The playwright engine's lifecycle through the public contract: one shared
 * browser per engine, one context per attempt, and honest idempotent
 * teardown. No runner involved - the hooks are driven directly, the way the
 * attempt executor drives them.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EngineCleanupContext,
  EngineHandle,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from '@e2edev/e2e/engine';
import { playwright } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';

function cleanup(signal = new AbortController().signal): EngineCleanupContext {
  return { signal, timeoutMs: 30_000 };
}

function operation(attemptId: string, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-pool', attemptId };
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
    app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
    testIdAttribute: 'data-testid',
    headed: false,
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
  await engine.app!.navigate!(`${app.url}/`, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('playwright engine lifecycle', () => {
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
    const engine = playwright();
    expect([...engine.capabilities].toSorted()).toEqual([
      'actions',
      'artifacts',
      'location',
      'observation',
      'state',
      'web',
    ]);
    expect(engine.name).toBe('playwright');
  });

  it('serves consecutive attempts from one browser and survives an attempt close', async () => {
    const engine = playwright();
    try {
      await boot(engine, app);
      expect(await openAttempt(engine, app, artifactsDir, 'a1')).toBe('Home');
      expect(await engine.url!(operation('a1'))).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
      // The next attempt reuses the pooled browser process, not a new launch.
      expect(await openAttempt(engine, app, artifactsDir, 'a2')).toBe('Home');
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const engine = playwright();
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
    const engine = playwright();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'd1', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/form`, operation('d1'));

      const snapshot = await engine.observe!(operation('d1'));
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]?.children?.length ?? 0).toBeGreaterThan(0);
      expect(snapshot.viewport).toEqual({ width: 1280, height: 720, scale: 1 });

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

  it('keeps tree attributes bounded while node reads expose every attribute', async () => {
    const engine = playwright();
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'attributes1', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/`, operation('attributes1'));

      const snapshot = await engine.observe!(operation('attributes1'));
      const treeNodes = [...walk(snapshot.nodes[0]!)];
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
    const engine = playwright();
    const shared: LocatorExpression = {
      kind: 'query',
      query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
    };
    const names = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.name);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'dv1', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/values`, operation('dv1'));

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
    const engine = playwright();
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
      await engine.app!.navigate!(`${app.url}/twins`, operation('v1'));

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

      // A role query already skips display:none; visible leaves it alone.
      expect(await engine.locate!(query('role', 'button', true), operation('v1'))).toHaveLength(1);

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
      // The marker is still on the screen a person reads: the label's own text keeps it.
      expect(await engine.locate!(query('text', 'Display name*', false), operation('v1'))).toHaveLength(1);

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
    const engine = playwright();
    const text = (value: string, visible: boolean): Extract<LocatorExpression, { kind: 'query' }> => ({
      kind: 'query',
      query: { kind: 'text', value: { kind: 'string', value, exact: true }, ...(visible ? { visible: true } : {}) },
    });
    const ariaHidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.attributes?.['aria-hidden']);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'v2', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/twins`, operation('v2'));
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
    const engine = playwright();
    const alpha = (visible: boolean): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true }, ...(visible ? { visible: true } : {}) },
    });
    const hidden = (nodes: readonly SemanticNode[]) => nodes.map((node) => node.states?.hidden);
    try {
      await boot(engine, app);
      await engine.startAttempt!({ attemptId: 'dv2', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/twins`, operation('dv2'));
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
    const engine = playwright();
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
    const engine = playwright();
    await withAttempt(engine, app, artifactsDir, 'e1', async () => {
      await expect(engine.startAttempt!(attempt('e2', artifactsDir))).rejects.toMatchObject({
        code: 'INVALID_STATE',
        retryable: false,
      });
      await engine.app!.navigate!(`${app.url}/`, operation('e1'));
      expect(await engine.url!(operation('e1'))).toBe(`${app.url}/`);
    });
  });

  it('treats endAttempt before startAttempt and dispose on a cold engine as no-ops', async () => {
    const cold = playwright();
    await expect(cold.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(cold.dispose!(cleanup())).resolves.toBeUndefined();

    const engine = playwright();
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
    const engine = playwright();
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
    const engine = playwright();
    await withAttempt(engine, app, artifactsDir, 'h1', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = engine.app!.navigate!(`${app.url}/slow`, operation('h1', controller.signal));
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it('round-trips persisted state through capture and restore, and clearState drops it', async () => {
    const engine = playwright();
    await withAttempt(engine, app, artifactsDir, 's1', async () => {
      const token = async (): Promise<string> => {
        const [heading] = await engine.locate!(byRole('heading'), operation('s1'));
        return heading?.name ?? '';
      };
      await engine.app!.navigate!(`${app.url}/state?set=abc`, operation('s1'));
      expect(await token()).toBe('abc');
      const state = await engine.state!.capture(operation('s1'));
      expect(state.format).toBe('playwright-storage-state');

      await engine.app!.clearState!(operation('s1'));
      await engine.app!.navigate!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('none');

      await engine.state!.restore(state, operation('s1'));
      await engine.app!.navigate!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('abc');

      await expect(
        engine.state!.restore({ format: 'playwright-storage-state', version: 1, data: '/etc/passwd' }, operation('s1')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
  });

  it('keeps a node id across observations while its element lives, and reports it stale once it is gone', async () => {
    const engine = playwright();
    await withAttempt(engine, app, artifactsDir, 'o1', async () => {
      await engine.app!.navigate!(`${app.url}/form`, operation('o1'));
      const first = await engine.observe!(operation('o1'));
      const textbox = [...walk(first.nodes[0]!)].find((node) => node.role === 'textbox');
      expect(textbox).toBeDefined();
      await engine.perform!(textbox!.ref, { kind: 'fill', value: 'fresh', sensitive: false }, operation('o1'));

      // The id is stamped on the element: a second look names the same
      // textbox by the same id, and the earlier ref still acts on it.
      const second = await engine.observe!(operation('o1'));
      const again = [...walk(second.nodes[0]!)].find((node) => node.role === 'textbox');
      expect(again!.ref.id).toBe(textbox!.ref.id);
      await engine.perform!(textbox!.ref, { kind: 'fill', value: 'late', sensitive: false }, operation('o1'));

      // A new document has none of the old elements: the id is gone with it.
      await engine.app!.navigate!(`${app.url}/`, operation('o1'));
      const third = await engine.observe!(operation('o1'));
      expect([...walk(third.nodes[0]!)].some((node) => node.ref.id === textbox!.ref.id)).toBe(false);
      await expect(
        engine.perform!(textbox!.ref, { kind: 'fill', value: 'gone', sensitive: false }, operation('o1')),
      ).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    });
  });

  it('keeps tracing across clearState: the earlier segment is kept and the trace still stops', async () => {
    const engine = playwright();
    const traceDir = mkdtempSync(path.join(tmpdir(), 'e2e-trace-'));
    try {
      await withAttempt(engine, app, traceDir, 't1', async () => {
        await engine.artifacts!.startTrace!(operation('t1'));
        await engine.app!.navigate!(`${app.url}/`, operation('t1'));
        await engine.app!.clearState!(operation('t1'));
        await engine.app!.navigate!(`${app.url}/form`, operation('t1'));
        const relative = await engine.artifacts!.stopTrace!(operation('t1'));
        expect(relative).toBe('trace/trace.zip');
        for (const file of [relative, 'trace/trace-part1.zip']) {
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

  it('masks secure fields in artifact screenshots and restarts the counter per attempt', async () => {
    const engine = playwright();
    const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
    try {
      await boot(engine, app);
      await engine.startAttempt!(attempt('m1', shotDir));
      await engine.app!.navigate!(`${app.url}/login`, operation('m1'));
      expect(await engine.artifacts!.screenshot('first', operation('m1'))).toBe('screenshots/001-first.png');
      await engine.endAttempt!(cleanup());

      await engine.startAttempt!(attempt('m2', shotDir));
      await engine.app!.navigate!(`${app.url}/login`, operation('m2'));
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
