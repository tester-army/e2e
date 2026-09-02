/**
 * LocatorEngine <-> backend error contract: retry-on-stale semantics and the
 * complete BackendError -> runner taxonomy mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  BackendError,
  type BackendErrorCode,
  type TargetSession,
  type LocatorExpression,
  type NodeRef,
  type SemanticNode,
} from '../../src/backend/surface.ts';
import { LocatorEngine, isNodeVisible, translateBackendError } from '../../src/locator/engine.ts';
import { E2EError } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';

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
 * A `NODE_STALE` thrown by a backend loaded through another module registry, so
 * it is not an instance of the runner's own `BackendError` class. The runner's
 * staleness retries must recognize it structurally, or a recoverable race
 * becomes an immediate test failure for every out-of-tree backend.
 */
function foreignStale(retryable: boolean): Error {
  const error = new Error('stale');
  error.name = 'BackendError';
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
        if (step === 'stale') throw new BackendError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'frame')
          throw new BackendError('FRAME_NOT_FOUND', 'frame missing', { retryable: true });
        throw new BackendError('BACKEND_FAILURE', 'backend died', { retryable: false });
      },
      async read() {
        const step = next(script.read, 'read');
        if (step === undefined || typeof step === 'function') return step?.() ?? NODE;
        if (step === 'stale') throw new BackendError('NODE_STALE', 'stale', { retryable: false });
        if (step === 'foreign-stale') throw foreignStale(false);
        if (step === 'stale-retryable') throw new BackendError('NODE_STALE', 'stale', { retryable: true });
        throw new BackendError('BACKEND_FAILURE', 'backend died', { retryable: false });
      },
      async perform() {
        const step = next(script.perform, 'perform');
        if (step === undefined || typeof step === 'function') return step?.();
        if (step === 'stale') throw new BackendError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'committed')
          throw new BackendError('ACTION_MAY_HAVE_COMMITTED', 'maybe committed', {
            retryable: false,
          });
        throw new BackendError('NOT_ACTIONABLE', 'covered by overlay', { retryable: false });
      },
      async swipe() {},
  } as unknown as TargetSession;
  const engine = new LocatorEngine({
    session,
    signal: new AbortController().signal,
    runId: 'run-1',
    attemptId: 'attempt-1',
    actionTimeout: options.actionTimeout ?? 1_000,
    assertionTimeout: 1_000,
    testDeadline: new Deadline(30_000),
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
  it('retries retryable frame misses until the backend recovers', async () => {
    const { engine, calls } = makeEngine({ resolve: ['frame', 'stale', () => [REF]] });
    const refs = await engine.resolveAll(EXPRESSION);
    expect(refs).toEqual([REF]);
    expect(calls.resolve).toBe(3);
  });

  it('translates a non-retryable resolve failure immediately without retrying', async () => {
    const { engine, calls } = makeEngine({ resolve: ['failure'] });
    await expect(engine.resolveAll(EXPRESSION)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'BACKEND_FAILURE',
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
      code: 'BACKEND_FAILURE',
      category: 'infrastructure',
    });
  });

  it('direct read surfaces stale nodes as LOCATOR_NOT_FOUND', async () => {
    const { engine } = makeEngine({ read: ['stale'] });
    await expect(engine.read(EXPRESSION)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });
});

describe('translateBackendError mapping table', () => {
  const cases: Array<[BackendErrorCode, string, string]> = [
    ['NODE_STALE', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_NOT_FOUND', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_AMBIGUOUS', 'test', 'LOCATOR_AMBIGUOUS'],
    ['NOT_ACTIONABLE', 'test', 'ACTION_FAILED'],
    ['ACTION_MAY_HAVE_COMMITTED', 'test', 'ACTION_FAILED'],
    ['OPERATION_TIMEOUT', 'test', 'ACTION_FAILED'],
    ['CANCELLED', 'infrastructure', 'CANCELLED'],
    ['UNSUPPORTED_CAPABILITY', 'configuration', 'UNSUPPORTED_CAPABILITY'],
    ['INVALID_STATE', 'test', 'APP_NOT_OPEN'],
    ['BACKEND_FAILURE', 'infrastructure', 'BACKEND_FAILURE'],
  ];

  it.each(cases)('%s -> %s/%s', (backendCode, category, code) => {
    const translated = translateBackendError(
      new BackendError(backendCode, 'boom', { retryable: false }),
    );
    expect(translated).toBeInstanceOf(E2EError);
    expect(translated.category).toBe(category);
    expect(translated.code).toBe(code);
    expect(translated.cause).toBeInstanceOf(BackendError);
  });

  it('passes existing E2EErrors through unchanged', () => {
    const original = new E2EError('configuration', 'INVALID_CONFIG', 'bad config');
    expect(translateBackendError(original)).toBe(original);
  });

  it('wraps unknown errors as infrastructure BACKEND_FAILURE', () => {
    const translated = translateBackendError(new Error('socket hangup'));
    expect(translated.category).toBe('infrastructure');
    expect(translated.code).toBe('BACKEND_FAILURE');
    expect(translated.message).toContain('socket hangup');
    expect(translateBackendError('string failure').message).toContain('string failure');
  });

  it('appends the locator description when an expression is provided', () => {
    const translated = translateBackendError(
      new BackendError('NODE_STALE', 'stale', { retryable: false }),
      EXPRESSION,
    );
    expect(translated.message).toContain('stale');
    expect(translated.message.length).toBeGreaterThan('node became stale'.length);
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
