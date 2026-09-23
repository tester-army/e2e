/**
 * `locator.filter({ has })`: core builds one filter expression with the inner
 * locator's expression under `has` and hands it to the engine unchanged; the
 * engine decides which matches keep it. The fake engine here resolves `has`
 * inside each candidate's subtree the way a real one does, so the reads on
 * the filtered locator are exercised end to end, and it refuses every
 * expression shape it does not model, so nothing passes by accident.
 */

import { describe, expect, it } from 'vitest';
import { EngineError, type LocatorExpression, type SemanticNode } from '../../src/engine/surface.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { roleQuery } from '../../src/locator/expression.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import type { Locator } from '../../src/types.ts';
import { snapshot } from '../helpers/snapshot.ts';

type SemanticQuery = Extract<LocatorExpression, { kind: 'query' }>['query'];

const REMOVE: SemanticNode = { ref: { id: 'remove', revision: '' }, role: 'button', name: 'Remove' };
const NOTE: SemanticNode = { ref: { id: 'note', revision: '' }, role: 'text', text: 'Read only' };
const ALPHA: SemanticNode = { ref: { id: 'alpha', revision: '' }, role: 'listitem', text: 'Alpha', children: [REMOVE] };
const BETA: SemanticNode = { ref: { id: 'beta', revision: '' }, role: 'listitem', text: 'Beta', children: [NOTE] };
const SCREEN = snapshot([ALPHA, BETA]);

function unsupported(): EngineError {
  return new EngineError('ENGINE_FAILURE', 'the fake engine does not speak this expression', { retryable: false });
}

/** Every node under `node`, itself excluded, in document order. */
function descendants(node: SemanticNode): SemanticNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...descendants(child)]);
}

/** Whether a node answers an exact-string role or text query; the only queries this fake speaks. */
function matches(query: SemanticQuery, node: SemanticNode): boolean {
  if (query.value.kind !== 'string') throw unsupported();
  if (query.kind === 'role') {
    if (node.role !== query.value.value) return false;
    if (query.name === undefined) return true;
    if (query.name.kind !== 'string') throw unsupported();
    return node.name === query.name.value;
  }
  if (query.kind === 'text') return node.text === query.value.value;
  throw unsupported();
}

/** Resolves an expression under `scope` as an engine would: `has` is matched inside each candidate, never against the whole screen. */
function resolve(expression: LocatorExpression, scope: SemanticNode): readonly SemanticNode[] {
  switch (expression.kind) {
    case 'query':
      if (expression.scope !== undefined) throw unsupported();
      return descendants(scope).filter((node) => matches(expression.query, node));
    case 'filter': {
      if (expression.hasText !== undefined) throw unsupported();
      const { has } = expression;
      return resolve(expression.source, scope).filter((node) => has === undefined || resolve(has, node).length > 0);
    }
    default:
      throw unsupported();
  }
}

/** A screen over the fake engine, logging every expression it is asked to locate. */
function screenOver() {
  const expressions: LocatorExpression[] = [];
  const engine = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => SCREEN,
    locate: async (expression) => {
      expressions.push(expression);
      return resolve(expression, SCREEN.root);
    },
  });
  const signal = new AbortController().signal;
  const screen = createScreen({
    engine: new LocatorEngine({
      session: createEngineSession({ engine, targetName: 'fake' }),
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      actionTimeout: 300,
      assertionTimeout: 300,
    }),
    steps: new StepRecorder('attempt'),
    secrets: { resolve: async () => 'plaintext' },
  });
  return { screen, expressions };
}

describe('locator.filter({ has })', () => {
  it('hands the engine one filter expression with the inner locator under has, unchanged', async () => {
    const { screen, expressions } = screenOver();
    await screen.getByRole('listitem').filter({ has: screen.getByRole('button', { name: 'Remove' }) }).count();
    expect(expressions).toEqual([
      {
        kind: 'filter',
        source: roleQuery('listitem', undefined, undefined),
        has: roleQuery('button', { name: 'Remove' }, undefined),
      },
    ]);
  });

  it('keeps a match whose subtree holds the inner locator and drops one that does not', async () => {
    const { screen } = screenOver();
    const items = screen.getByRole('listitem');
    const removable = items.filter({ has: screen.getByRole('button', { name: 'Remove' }) });
    expect(await removable.count()).toBe(1);
    expect(await removable.textContent()).toBe('Alpha');
    expect(await items.filter({ has: screen.getByText('Read only') }).allTextContents()).toEqual(['Beta']);
    expect(await items.filter({ has: screen.getByRole('link') }).count()).toBe(0);
  });

  it('names the whole chain when a filtered read finds nothing', async () => {
    const { screen } = screenOver();
    await expect(
      screen.getByRole('listitem').filter({ has: screen.getByRole('link') }).textContent(),
    ).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('getByRole("listitem").filter({ has: getByRole("link") })'),
    });
  });

  it('refuses a has that is not an e2e locator before any engine call', () => {
    const { screen, expressions } = screenOver();
    expect(() => screen.getByRole('listitem').filter({ has: {} as unknown as Locator })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
    expect(expressions).toEqual([]);
  });
});
