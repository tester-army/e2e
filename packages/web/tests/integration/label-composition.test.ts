/**
 * An exact label query keeps its exactness when it composes: as a `has`
 * filter it picks the row whose control that label names and no row whose
 * label merely contains the text, and it still matches what the standalone
 * query matches, an aria-hidden marker in the label included. The fixture is
 * `/rows`; see its comment for the layout.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, LocatorExpression, OperationContext, TextPattern } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-rows', attemptId, origin: 'test' };
}

function byLabel(value: string, exact: boolean, visible?: boolean): LocatorExpression {
  const pattern: TextPattern = { kind: 'string', value, exact };
  return { kind: 'query', query: { kind: 'label', value: pattern, ...(visible === undefined ? {} : { visible }) } };
}

const rows: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'listitem', exact: true } } };

function rowsWith(has: LocatorExpression): LocatorExpression {
  return { kind: 'filter', source: rows, has };
}

function removeButtonOf(scope: LocatorExpression): LocatorExpression {
  return {
    kind: 'query',
    query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Remove', exact: true } },
    scope,
  };
}

async function boot(engine: EngineHandle, app: FixtureApp): Promise<void> {
  await engine.init!({
    runId: 'run-rows',
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

describe('an exact label query composed as a has filter', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const engine = web();
  const op = operation('rows-1');
  const locate = (expression: LocatorExpression) => engine.locate!(expression, op);
  const testIds = (expression: LocatorExpression) => locate(expression).then((nodes) => nodes.map((node) => node.testId));

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-rows-'));
    await boot(engine, app);
    await engine.startAttempt!({ attemptId: 'rows-1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/rows`, op);
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('keeps the exact predicate: one row for the exact label, two for the substring, as standalone', async () => {
    expect((await locate(byLabel('Name', true))).map((node) => node.name)).toEqual(['Name', 'Name']);
    expect(await testIds(rowsWith(byLabel('Name', true)))).toEqual(['row-name', 'row-name-hidden']);
    expect(await testIds(rowsWith(byLabel('Name', false)))).toEqual(['row-last-name', 'row-name', 'row-name-hidden']);
    expect(await testIds(rowsWith(byLabel('Last Name', true)))).toEqual(['row-last-name']);
    expect(await testIds(rowsWith(byLabel('Nowhere', true)))).toEqual([]);
  });

  it('reads the label as the standalone query does: an aria-hidden marker never hides the row', async () => {
    expect(await testIds(rowsWith(byLabel('Name*', true)))).toEqual([]);
    expect(await testIds(rowsWith(byLabel('Say "hi" >> now', true)))).toEqual(['row-quoted']);
  });

  it('keeps the visible flag when composed: a row whose matching input is hidden drops out', async () => {
    expect((await locate(byLabel('Name', true, true))).map((node) => node.states?.hidden)).toEqual([undefined]);
    expect(await testIds(rowsWith(byLabel('Name', true, true)))).toEqual(['row-name']);
    expect(await testIds(rowsWith(byLabel('Name', false, true)))).toEqual(['row-last-name', 'row-name']);
  });

  it('composes onto a position and a child query, and acts on the row it picked', async () => {
    const remove = removeButtonOf({ kind: 'index', source: rowsWith(byLabel('Name', true)), index: 'first' });
    const [button] = await locate(remove);
    expect(button).toBeDefined();
    await engine.perform!(button!.ref, { kind: 'tap' }, op);
    expect(await testIds(rows)).toEqual(['row-last-name', 'row-quoted', 'row-name-hidden']);
    expect(await testIds(byLabel('Last Name', true))).toHaveLength(1);
  });
});
