/**
 * LocatorEngine <-> engine error contract: retry-on-stale semantics and the
 * complete EngineError -> runner taxonomy mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  EngineError,
  type EngineErrorCode,
  type TargetSession,
  type LocatorExpression,
  type NodeRef,
  type SemanticNode,
} from '../../src/engine/surface.ts';
import { LocatorEngine, isNodeVisible, translateLocatorError } from '../../src/locator/engine.ts';
import { E2EError } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { roleQuery, testIdQuery, textQuery } from '../../src/locator/expression.ts';

const REF: NodeRef = { id: 'node-1', revision: 'rev-1' };
const NODE: SemanticNode = { ref: REF, role: 'button', name: 'Submit' };
const EXPRESSION: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } },
};

interface ScreenScript {
  resolve?: Array<(() => readonly NodeRef[]) | 'stale' | 'frame' | 'failure' | 'foreign-stale'>;
  read?: Array<(() => SemanticNode) | 'stale' | 'stale-retryable' | 'failure' | 'foreign-stale'>;
  perform?: Array<(() => void) | 'stale' | 'committed' | 'not-actionable' | 'foreign-stale'>;
}

/**
 * A `NODE_STALE` thrown by an engine loaded through another module registry, so
 * it is not an instance of the runner's own `EngineError` class. The runner's
 * staleness retries must recognize it structurally, or a recoverable race
 * becomes an immediate test failure for every out-of-tree engine.
 */
function foreignStale(retryable: boolean): Error {
  const error = new Error('stale');
  error.name = 'EngineError';
  Object.assign(error, { code: 'NODE_STALE', retryable });
  return error;
}

function makeEngine(script: ScreenScript, options: { actionTimeout?: number } = {}) {
  const calls = { resolve: 0, read: 0, perform: 0 };
  const next = <T>(steps: T[] | undefined, kind: keyof typeof calls): T | undefined => {
    const step = steps?.[calls[kind]];
    calls[kind] += 1;
    return step;
  };
  const session = {
      async locate() {
        const step = next(script.resolve, 'resolve');
        if (step === undefined || typeof step === 'function') return step?.() ?? [REF];
        if (step === 'stale') throw new EngineError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'frame')
          throw new EngineError('FRAME_NOT_FOUND', 'frame missing', { retryable: true });
        throw new EngineError('ENGINE_FAILURE', 'engine died', { retryable: false });
      },
      async read() {
        const step = next(script.read, 'read');
        if (step === undefined || typeof step === 'function') return step?.() ?? NODE;
        if (step === 'stale') throw new EngineError('NODE_STALE', 'stale', { retryable: false });
        if (step === 'foreign-stale') throw foreignStale(false);
        if (step === 'stale-retryable') throw new EngineError('NODE_STALE', 'stale', { retryable: true });
        throw new EngineError('ENGINE_FAILURE', 'engine died', { retryable: false });
      },
      async perform() {
        const step = next(script.perform, 'perform');
        if (step === undefined || typeof step === 'function') return step?.();
        if (step === 'stale') throw new EngineError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'committed')
          throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'maybe committed', {
            retryable: false,
          });
        throw new EngineError('NOT_ACTIONABLE', 'covered by overlay', { retryable: false });
      },
      async swipe() {},
  } as unknown as TargetSession;
  const engine = new LocatorEngine({
    session,
    budget: new AttemptBudget(new AbortController().signal, new Deadline(30_000)),
    runId: 'run-1',
    attemptId: 'attempt-1',
    actionTimeout: options.actionTimeout ?? 1_000,
    assertionTimeout: 1_000,
  });
  return { engine, calls };
}

describe('LocatorEngine read retry contract', () => {
  it('re-resolves a read whose ref a concurrent resolution superseded', async () => {
    const { engine, calls } = makeEngine({ read: ['stale-retryable', () => NODE] });
    expect(await engine.read(EXPRESSION)).toEqual(NODE);
    expect(calls.resolve).toBe(2);
    expect(calls.read).toBe(2);
  });

  it('translates a non-retryable stale read without retrying', async () => {
    const { engine, calls } = makeEngine({ read: ['stale'] });
    await expect(engine.read(EXPRESSION)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(calls.read).toBe(1);
  });
});

describe('LocatorEngine resolve retry contract', () => {
  it('retries retryable frame misses until the engine recovers', async () => {
    const { engine, calls } = makeEngine({ resolve: ['frame', 'stale', () => [REF]] });
    const refs = await engine.resolveAll(EXPRESSION);
    expect(refs).toEqual([REF]);
    expect(calls.resolve).toBe(3);
  });

  it('translates a non-retryable resolve failure immediately without retrying', async () => {
    const { engine, calls } = makeEngine({ resolve: ['failure'] });
    await expect(engine.resolveAll(EXPRESSION)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'ENGINE_FAILURE',
    });
    expect(calls.resolve).toBe(1);
  });

  it('gives up on persistent retryable errors at the deadline with the translated error', async () => {
    const { engine } = makeEngine(
      { resolve: Array.from({ length: 50 }, () => 'stale' as const) },
      { actionTimeout: 350 },
    );
    await expect(engine.resolveAll(EXPRESSION)).rejects.toMatchObject({
      category: 'test',
      code: 'LOCATOR_NOT_FOUND',
    });
  });

  it('fails ambiguous matches immediately with LOCATOR_AMBIGUOUS', async () => {
    const { engine, calls } = makeEngine({
      resolve: [() => [REF, { id: 'node-2', revision: 'rev-1' }]],
    });
    await expect(
      engine.resolveExactlyOne(EXPRESSION, new Deadline(5_000)),
    ).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS', category: 'test' });
    expect(calls.resolve).toBe(1);
  });

  it('polls zero matches until the deadline, then LOCATOR_NOT_FOUND', async () => {
    const { engine, calls } = makeEngine({
      resolve: Array.from({ length: 50 }, () => () => [] as readonly NodeRef[]),
    });
    await expect(
      engine.resolveExactlyOne(EXPRESSION, new Deadline(350)),
    ).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(calls.resolve).toBeGreaterThan(1);
  });
});

describe('LocatorEngine perform contract', () => {
  it('re-resolves and retries the action after a retryable stale node', async () => {
    const { engine, calls } = makeEngine({ perform: ['stale', () => undefined] });
    await engine.perform(EXPRESSION, { kind: 'tap' });
    expect(calls.perform).toBe(2);
    expect(calls.resolve).toBe(2);
  });

  it('never repeats an action that may have committed', async () => {
    const { engine, calls } = makeEngine({ perform: ['committed'] });
    await expect(engine.perform(EXPRESSION, { kind: 'tap' })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      category: 'test',
    });
    expect(calls.perform).toBe(1);
  });

  it('maps NOT_ACTIONABLE to ACTION_FAILED without retrying', async () => {
    const { engine, calls } = makeEngine({ perform: ['not-actionable'] });
    await expect(engine.perform(EXPRESSION, { kind: 'tap' })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
    });
    expect(calls.perform).toBe(1);
  });
});

describe('LocatorEngine read contract', () => {
  it('collapses stale reads to a zero-count sample so assertion polls re-resolve', async () => {
    const { engine } = makeEngine({ read: ['stale'] });
    const sample = await engine.tryRead(EXPRESSION, new Deadline(5_000));
    expect(sample).toEqual({ node: null, count: 0 });
  });

  it('translates non-stale read failures', async () => {
    const { engine } = makeEngine({ read: ['failure'] });
    await expect(engine.tryRead(EXPRESSION, new Deadline(5_000))).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      category: 'infrastructure',
    });
  });

  it('direct read surfaces stale nodes as LOCATOR_NOT_FOUND', async () => {
    const { engine } = makeEngine({ read: ['stale'] });
    await expect(engine.read(EXPRESSION)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });
});

describe('translateLocatorError mapping table', () => {
  const cases: Array<[EngineErrorCode, string, string]> = [
    ['NODE_STALE', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_NOT_FOUND', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_AMBIGUOUS', 'test', 'LOCATOR_AMBIGUOUS'],
    ['NOT_ACTIONABLE', 'test', 'ACTION_FAILED'],
    ['ACTION_MAY_HAVE_COMMITTED', 'test', 'ACTION_FAILED'],
    ['OPERATION_TIMEOUT', 'test', 'ACTION_FAILED'],
    ['CANCELLED', 'infrastructure', 'CANCELLED'],
    ['UNSUPPORTED_CAPABILITY', 'configuration', 'UNSUPPORTED_CAPABILITY'],
    ['INVALID_STATE', 'test', 'APP_NOT_OPEN'],
    ['ENGINE_FAILURE', 'infrastructure', 'ENGINE_FAILURE'],
  ];

  it.each(cases)('%s -> %s/%s', (engineCode, category, code) => {
    const translated = translateLocatorError(
      new EngineError(engineCode, 'boom', { retryable: false }),
    );
    expect(translated).toBeInstanceOf(E2EError);
    expect(translated.category).toBe(category);
    expect(translated.code).toBe(code);
    expect(translated.cause).toBeInstanceOf(EngineError);
  });

  it('passes existing E2EErrors through unchanged', () => {
    const original = new E2EError('configuration', 'INVALID_CONFIG', 'bad config');
    expect(translateLocatorError(original)).toBe(original);
  });

  it('wraps unknown errors as infrastructure ENGINE_FAILURE', () => {
    const translated = translateLocatorError(new Error('socket hangup'));
    expect(translated.category).toBe('infrastructure');
    expect(translated.code).toBe('ENGINE_FAILURE');
    expect(translated.message).toContain('socket hangup');
    expect(translateLocatorError('string failure').message).toContain('string failure');
  });

  it('appends the locator description when an expression is provided', () => {
    const translated = translateLocatorError(
      new EngineError('NODE_STALE', 'stale', { retryable: false }),
      EXPRESSION,
    );
    expect(translated.message).toContain('stale');
    expect(translated.message.length).toBeGreaterThan('node became stale'.length);
  });
});

describe('LocatorEngine visible queries', () => {
  /** A visible node and its hidden twin, as an engine that ignores `visible` would report them. */
  const twins: SemanticNode[] = [
    { ref: { id: 'shown', revision: '' }, role: 'button', name: 'Save', states: {} },
    { ref: { id: 'hidden', revision: '' }, role: 'button', name: 'Save', states: { hidden: true } },
  ];

  /** Locator engine over the real session adapter and an engine that answers every locate with the twins. */
  function makeLocatorEngineOverEngine(nodes: readonly SemanticNode[] = twins) {
    const expressions: LocatorExpression[] = [];
    const session = createEngineSession({
      engine: defineEngine({
        name: 'twins',
        version: '1.0.0',
        spiVersion: 1,
        observe: async () => ({ nodes: [] }),
        locate: async (expression) => {
          expressions.push(expression);
          return nodes;
        },
      }),
      targetName: 'twins',
    });
    const engine = new LocatorEngine({
      session,
      budget: new AttemptBudget(new AbortController().signal, new Deadline(30_000)),
      runId: 'run-1',
      attemptId: 'attempt-1',
      actionTimeout: 1_000,
      assertionTimeout: 1_000,
    });
    return { engine, expressions };
  }

  const kinds: Array<[string, (visible: boolean | undefined) => LocatorExpression]> = [
    ['getByRole', (visible) => roleQuery('button', { name: 'Save', ...(visible === undefined ? {} : { visible }) }, undefined)],
    ['getByText', (visible) => textQuery('text', 'Save', visible === undefined ? undefined : { visible }, undefined)],
    ['getByLabel', (visible) => textQuery('label', 'Save', visible === undefined ? undefined : { visible }, undefined)],
    ['getByPlaceholder', (visible) => textQuery('placeholder', 'Save', visible === undefined ? undefined : { visible }, undefined)],
    ['getByDisplayValue', (visible) => textQuery('displayValue', 'Save', visible === undefined ? undefined : { visible }, undefined)],
    ['getByTestId', (visible) => testIdQuery('save', visible === undefined ? undefined : { visible }, undefined)],
  ];

  it.each(kinds)('%s with visible: true resolves the shown twin and ignores the hidden one', async (_kind, build) => {
    const { engine } = makeLocatorEngineOverEngine();
    const ref = await engine.resolveExactlyOne(build(true), new Deadline(5_000));
    expect(ref.id).toBe('shown');
    expect(await engine.resolveAll(build(true))).toHaveLength(1);
  });

  it.each(kinds)('%s without visible keeps the hidden twin, so the pair is LOCATOR_AMBIGUOUS', async (_kind, build) => {
    const { engine } = makeLocatorEngineOverEngine();
    await expect(engine.resolveExactlyOne(build(undefined), new Deadline(5_000))).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
    });
    await expect(engine.resolveExactlyOne(build(false), new Deadline(5_000))).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
    });
    expect(await engine.resolveAll(build(undefined))).toHaveLength(2);
  });

  it('names the predicate in the ambiguity message when two visible nodes remain', async () => {
    const { engine } = makeLocatorEngineOverEngine([
      { ref: { id: 'a', revision: '' }, role: 'button', name: 'Save' },
      { ref: { id: 'b', revision: '' }, role: 'button', name: 'Save' },
    ]);
    await expect(engine.resolveExactlyOne(kinds[1]![1](true), new Deadline(5_000))).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
      message: expect.stringContaining('getByText("Save", visible: true)'),
    });
  });

  it('keeps nodes whose engine reports no visibility at all', async () => {
    const { engine } = makeLocatorEngineOverEngine([{ ref: { id: 'unknown', revision: '' }, role: 'button', name: 'Save' }]);
    const ref = await engine.resolveExactlyOne(kinds[0]![1](true), new Deadline(5_000));
    expect(ref.id).toBe('unknown');
  });

  it('hands a visible query under an index to the engine unchanged: only it can filter before nth', async () => {
    const { engine, expressions } = makeLocatorEngineOverEngine();
    const indexed: LocatorExpression = { kind: 'index', source: kinds[1]![1](true), index: 'first' };
    // The adapter cannot know which of the engine's answers came first, so it
    // must not second-guess them; the engine applied `visible` before `first`.
    expect(await engine.resolveAll(indexed)).toHaveLength(2);
    expect(expressions[0]).toEqual(indexed);
  });
});

describe('isNodeVisible', () => {
  it('treats missing nodes and hidden state correctly', () => {
    expect(isNodeVisible(null)).toBe(false);
    expect(isNodeVisible({ ...NODE, states: { hidden: true } })).toBe(false);
    expect(isNodeVisible({ ...NODE, states: { hidden: false } })).toBe(true);
    expect(isNodeVisible({ ref: REF, role: 'button' })).toBe(true);
  });
});

describe('LocatorEngine retries a cross-realm driver failure', () => {
  it('retries a foreign retryable resolve failure', async () => {
    const { engine, calls } = makeEngine({ resolve: ['foreign-stale', () => [REF]] });
    await expect(engine.resolveForRead(EXPRESSION)).resolves.toEqual(REF);
    expect(calls.resolve).toBe(2);
  });

  it('treats a foreign stale read as zero matches while polling', async () => {
    const { engine } = makeEngine({ read: ['foreign-stale'] });
    await expect(engine.tryRead(EXPRESSION, new Deadline(0))).resolves.toEqual({
      node: null,
      count: 0,
    });
  });

  it('re-resolves after a foreign stale perform', async () => {
    const { engine, calls } = makeEngine({ perform: ['foreign-stale', () => {}] });
    await engine.perform(EXPRESSION, { kind: 'tap' });
    expect(calls.perform).toBe(2);
  });
});
