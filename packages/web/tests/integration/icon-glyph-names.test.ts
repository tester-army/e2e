/**
 * CSS generated content names a control as the browser names it, and an
 * icon font's private-use glyph never does: the tree and the role locator
 * agree on `button "Sign in"` for Font Awesome's `<i class="fa-sign-in">`, on
 * `button "→ Next"` for a real character, and on a glyph between two words
 * as a space. A glyph-only link reads as its title, the word a person
 * hovering it sees, though the browser names it by the glyph.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, LocatorExpression, OperationContext, SemanticNode } from 'e2e/engine';
import { surfaceOf, web } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreAppLog, noSecrets } from '../helpers/secrets.ts';

const PAGE = `
  <style>
    .next::before { content: "\\2192"; }
    .glyph::before { content: "\\f090"; }
    .badge::after { content: attr(data-count) " new"; }
  </style>
  <button><i class="next"> Next</i></button>
  <button><i class="glyph"> Sign in</i></button>
  <a href="/inbox" class="badge" data-count="3">Inbox</a>
  <a href="/leave" title="Sign out"><i class="glyph"></i></a>
  <a href="/bare"><i class="glyph"></i></a>
  <button>Log<i class="glyph"></i>out</button>
  <label class="next">Email <input></label>
  <label><i class="glyph"></i> Phone <input></label>
  <h2 data-testid="don't">Don't "quote" a &gt;&gt; b</h2>
`;

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-glyphs', attemptId: 'glyphs-1', origin: 'test' };
}

/** A role query, with a string name when one is given. */
function byRole(role: string, name?: string, exact = true): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: role, exact: true },
      ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact } }),
    },
  };
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

describe('names with CSS generated content', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const engine: EngineHandle = web();
  const op = operation();
  const names = (expression: LocatorExpression) => engine.locate!(expression, op).then((nodes) => nodes.map((node) => node.name));

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-glyphs-'));
    await engine.init!({
      runId: 'run-glyphs', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'glyphs-1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, appLog: ignoreAppLog });
    await engine.session!.open!(`${app.url}/login`, op);
    await surfaceOf(engine)!.page().setContent(PAGE);
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reads generated text into a name, reads icon glyphs as spaces, and names a glyph-only link by its title or not at all', async () => {
    const snapshot = await engine.observe!(op);
    const read = flatten(snapshot.root).filter((node) => node.role === 'button' || node.role === 'link').map((node) => [node.role, node.name]);
    expect(read).toEqual([
      ['button', '→ Next'],
      ['button', 'Sign in'],
      ['link', 'Inbox3 new'],
      ['link', 'Sign out'],
      ['link', undefined],
      ['button', 'Log out'],
    ]);
  });

  it('finds each control by the name the tree reports', async () => {
    expect(await names(byRole('button', '→ Next'))).toEqual(['→ Next']);
    expect(await names(byRole('button', 'Sign in'))).toEqual(['Sign in']);
    expect(await names(byRole('link', 'Inbox3 new'))).toEqual(['Inbox3 new']);
    expect(await names(byRole('button', 'Log out'))).toEqual(['Log out']);
  });

  it('matches a substring across a glyph and stays exact where asked', async () => {
    expect(await names(byRole('button', 'sign IN', false))).toEqual(['Sign in']);
    expect(await names(byRole('button', 'Sign'))).toEqual([]);
    expect(await names(byRole('button', 'Next'))).toEqual([]);
    expect(await names(byRole('link', 'new', false))).toEqual(['Inbox3 new']);
  });

  it('matches a name with quotes and >> however the query is chained', async () => {
    const quoted = `Don't "quote" a >> b`;
    const first = (source: LocatorExpression): LocatorExpression => ({ kind: 'index', source, index: 'first' });
    const unicode = (kind: 'text' | 'testId', source: string, flags = 'u'): LocatorExpression => ({
      kind: 'query',
      query: { kind, value: { kind: 'regexp', source, flags } },
    });
    expect(await names(first(byRole('heading', quoted)))).toEqual([quoted]);
    expect(await names(first(byRole('heading', `don't "QUOTE"`, false)))).toEqual([quoted]);
    expect(await names({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, name: { kind: 'string', value: "Don't", exact: false }, visible: true } })).toEqual([quoted]);
    expect(await names(first(unicode('text', quoted)))).toEqual([quoted]);
    expect(await names(first(unicode('text', `[']t "quote" a >>`, 'v')))).toEqual([quoted]);
    expect(await names(first(unicode('testId', "^don't$")))).toEqual([quoted]);
  });

  it('keeps generated content out of label text, as getByLabel reads it, and drops a glyph from it', async () => {
    const label = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'label', value: { kind: 'string', value, exact: true } } });
    expect(await names(label('Email'))).toEqual(['→Email']);
    expect(await names(label('Phone'))).toEqual(['Phone']);
  });
});
