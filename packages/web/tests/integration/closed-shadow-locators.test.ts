/**
 * Deterministic locators inside closed shadow roots: every query kind resolves
 * the nodes the reader already observes there, actions and reads work on them,
 * and the rules that hold outside (strictness by count, the `visible` flag,
 * positions, scopes, filters) hold across the boundary, with each node found
 * once. The fixture is `/closed-form`; see its comment for the layout.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EngineCleanupContext,
  EngineHandle,
  LocatorExpression,
  OperationContext,
  SemanticNode,
  SemanticQuery,
  TextPattern,
} from 'e2e/engine';
import { web } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-closed', attemptId, origin: 'test' };
}

function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

function loose(value: string): TextPattern {
  return { kind: 'string', value, exact: false };
}

function query(semantic: SemanticQuery, scope?: LocatorExpression): LocatorExpression {
  return { kind: 'query', query: semantic, ...(scope === undefined ? {} : { scope }) };
}

function byRole(role: string, name?: string, visible?: boolean): LocatorExpression {
  return query({
    kind: 'role',
    value: exact(role),
    ...(name === undefined ? {} : { name: exact(name) }),
    ...(visible === undefined ? {} : { visible }),
  });
}

function byText(value: TextPattern, visible?: boolean): LocatorExpression {
  return query({ kind: 'text', value, ...(visible === undefined ? {} : { visible }) });
}

function byTestId(value: string): LocatorExpression {
  return query({ kind: 'testId', value: exact(value) });
}

/** Depth-first walk of one observation tree. */
function* walk(node: SemanticNode): Generator<SemanticNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

async function boot(engine: EngineHandle, app: FixtureApp): Promise<void> {
  await engine.init!({
    runId: 'run-closed',
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

describe('locators inside closed shadow roots', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const engine = web();
  const op = operation('closed-1');
  const locate = (expression: LocatorExpression) => engine.locate!(expression, op);

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-closed-'));
    await boot(engine, app);
    await engine.startAttempt!({ attemptId: 'closed-1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/closed-form`, op);
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('resolves every query kind to the node the observed tree names', async () => {
    const observed = [...walk((await engine.observe!(op)).root)];
    const observedSubmit = observed.find((node) => node.role === 'button' && node.name === 'Submit');
    expect(observedSubmit?.testId).toBe('submit');

    const submit = await locate(byRole('button', 'Submit'));
    expect(submit.map((node) => node.testId)).toEqual(['submit']);

    const placeholder = await locate(query({ kind: 'placeholder', value: exact('Access code') }));
    expect(placeholder.map((node) => node.testId)).toEqual(['code']);

    const labelled = await locate(query({ kind: 'label', value: exact('Nickname') }));
    expect(labelled.map((node) => node.value)).toEqual(['ada']);
    const labelledLoosely = await locate(query({ kind: 'label', value: loose('nick') }));
    expect(labelledLoosely.map((node) => node.value)).toEqual(['ada']);

    const hint = await locate(byText(exact('Access code hint: SHADOW-42'), true));
    expect(hint.map((node) => node.testId)).toEqual(['hint']);
    const hintLoosely = await locate(byText(loose('code hint'), true));
    expect(hintLoosely.map((node) => node.testId)).toEqual(['hint']);

    const valued = await locate(query({ kind: 'displayValue', value: exact('ada') }));
    expect(valued.map((node) => node.attributes?.['name'])).toEqual(['nickname']);

    const testId = await locate(byTestId('code'));
    expect(testId.map((node) => node.attributes?.['placeholder'])).toEqual(['Access code']);
  });

  it('reaches roots nested either way round: open inside closed, closed inside open', async () => {
    const buttons = await locate(byRole('button'));
    expect(buttons.map((node) => node.name)).toEqual([
      'Twin',
      'Submit',
      'Twin',
      'Twin',
      'Open inside closed',
      'Closed inside open',
      'Sidecar',
    ]);
  });

  it('finds a node once, whether Playwright or the closed-root path reaches it, so counts stay strict', async () => {
    const twins = await locate(byRole('button', 'Twin'));
    expect(twins.map((node) => node.testId)).toEqual(['twin-light', 'twin-a', 'twin-b']);
    // A position counts light-DOM matches first, then a closed root's in its order.
    const second = await locate({ kind: 'index', source: byRole('button', 'Twin'), index: 1 });
    expect(second.map((node) => node.testId)).toEqual(['twin-a']);
    const last = await locate({ kind: 'index', source: byRole('button', 'Twin'), index: 'last' });
    expect(last.map((node) => node.testId)).toEqual(['twin-b']);
  });

  it('applies the visible flag and the hidden exclusion of a role query inside the root', async () => {
    const hints = await locate(byText(exact('Access code hint: SHADOW-42')));
    expect(hints.map((node) => node.testId).toSorted()).toEqual(['hint', 'hint-ghost']);
    const shown = await locate(byText(exact('Access code hint: SHADOW-42'), true));
    expect(shown.map((node) => node.testId)).toEqual(['hint']);
    // A role query never matches a hidden node, as outside a closed root.
    const submits = await locate(byRole('button', 'Submit'));
    expect(submits.map((node) => node.testId)).toEqual(['submit']);
  });

  it('scopes a child query to a root inside the closed root, and lets has cross the boundary', async () => {
    const advanced = byRole('region', 'Advanced');
    const nested = await locate(query({ kind: 'role', value: exact('button') }, advanced));
    expect(nested.map((node) => node.name)).toEqual(['Open inside closed', 'Closed inside open']);

    // The host is a light-DOM element; the button it must contain is inside its closed root.
    const host: LocatorExpression = { kind: 'selector', selector: 'x-access' };
    const withSubmit = await locate({ kind: 'filter', source: host, has: byRole('button', 'Submit') });
    expect(withSubmit).toHaveLength(1);
    const withSidecar = await locate({ kind: 'filter', source: host, has: byRole('button', 'Sidecar') });
    expect(withSidecar).toHaveLength(0);
  });

  it('reads hasText as Playwright does, so text inside a closed root does not count toward the host', async () => {
    const host: LocatorExpression = { kind: 'selector', selector: 'x-access' };
    const byHostText = await locate({ kind: 'filter', source: host, hasText: loose('SHADOW-42') });
    expect(byHostText).toHaveLength(0);
    // Inside the root the text is ordinary text again.
    const hintParagraph = await locate({ kind: 'filter', source: byTestId('hint'), hasText: loose('SHADOW-42') });
    expect(hintParagraph).toHaveLength(1);
  });

  it('matches a label an aria-labelledby id names in the control\'s own tree, in a closed root and an open one below it', async () => {
    const observed = [...walk((await engine.observe!(op)).root)];
    expect(observed.find((node) => node.testId === 'pin')).toMatchObject({ role: 'textbox', name: 'PIN' });
    expect(observed.find((node) => node.testId === 'tone')).toMatchObject({ role: 'textbox', name: 'Tone' });

    const pin = await locate(query({ kind: 'label', value: exact('PIN') }));
    expect(pin.map((node) => node.testId)).toEqual(['pin']);
    const pinLoosely = await locate(query({ kind: 'label', value: loose('pin') }));
    expect(pinLoosely.map((node) => node.testId)).toEqual(['pin']);
    const tone = await locate(query({ kind: 'label', value: exact('Tone') }));
    expect(tone.map((node) => node.testId)).toEqual(['tone']);
    const toneLoosely = await locate(query({ kind: 'label', value: loose('tone') }));
    expect(toneLoosely.map((node) => node.testId)).toEqual(['tone']);
  });

  it('reports focus on the node that holds it, inside a closed root and inside an open root below it', async () => {
    const focusedOf = async (testId: string) => (await locate(byTestId(testId)))[0]?.states?.['focused'];

    const [pin] = await locate(byTestId('pin'));
    await engine.perform!(pin!.ref, { kind: 'tap' }, op);
    expect(await focusedOf('pin')).toBe(true);
    expect(await focusedOf('code')).toBeUndefined();

    const [tone] = await locate(byTestId('tone'));
    await engine.perform!(tone!.ref, { kind: 'tap' }, op);
    expect(await focusedOf('tone')).toBe(true);
    expect(await focusedOf('pin')).toBeUndefined();
    const focused = [...walk((await engine.observe!(op)).root)].filter((node) => node.states?.['focused'] === true);
    expect(focused.map((node) => node.testId)).toEqual(['tone']);
  });

  it('fills, presses, taps, and reads the nodes it located', async () => {
    const [code] = await locate(query({ kind: 'placeholder', value: exact('Access code') }));
    await engine.perform!(code!.ref, { kind: 'fill', value: 'WRONG-1', sensitive: false }, op);
    expect((await locate(byTestId('code')))[0]?.value).toBe('WRONG-1');
    await engine.perform!(code!.ref, { kind: 'press', key: 'Enter' }, op);
    expect((await locate(byText(exact('denied'))))).toHaveLength(1);

    await engine.perform!(code!.ref, { kind: 'fill', value: 'SHADOW-42', sensitive: false }, op);
    const [submit] = await locate(byRole('button', 'Submit'));
    await engine.perform!(submit!.ref, { kind: 'tap' }, op);
    const [status] = await locate({ kind: 'selector', selector: '#status' });
    expect(status?.text).toBe('granted');
    expect((await locate(query({ kind: 'displayValue', value: exact('SHADOW-42') }))).map((node) => node.testId)).toEqual(['code']);
  });
});

describe('match order across one closed root', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const engine = web();
  const op = operation('closed-order');

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-closed-order-'));
    await boot(engine, app);
    await engine.startAttempt!({ attemptId: 'closed-order', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/closed-order`, op);
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('lists light-DOM matches first and the closed root after, where the observed tree lists them in place', async () => {
    // The host comes before the light-DOM button, so the reader reads Alpha first.
    const observed = [...walk((await engine.observe!(op)).root)].filter((node) => node.role === 'button');
    expect(observed.map((node) => node.name)).toEqual(['Alpha', 'Beta']);
    // A locator searches the light DOM as one root and the closed root as the next.
    const located = await engine.locate!(byRole('button'), op);
    expect(located.map((node) => node.name)).toEqual(['Beta', 'Alpha']);
    const first = await engine.locate!({ kind: 'index', source: byRole('button'), index: 'first' }, op);
    expect(first.map((node) => node.name)).toEqual(['Beta']);
  });
});
