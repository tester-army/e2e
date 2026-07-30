/**
 * LocatorEngine <-> driver error contract: retry-on-stale semantics and the
 * complete DriverError -> runner taxonomy mapping (spec 10-drivers.md).
 */

import { describe, expect, it } from 'vitest';
import {
  DriverError,
  type DriverErrorCode,
  type DriverSession,
  type LocatorExpression,
  type NodeRef,
  type SemanticNode,
} from '../../src/driver/index.ts';
import { LocatorEngine, isNodeVisible, translateDriverError } from '../../src/locator/engine.ts';
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
  read?: Array<(() => SemanticNode) | 'stale' | 'failure' | 'foreign-stale'>;
  perform?: Array<(() => void) | 'stale' | 'committed' | 'not-actionable' | 'foreign-stale'>;
}

/**
 * A `NODE_STALE` thrown by a driver loaded through another module registry, so
 * it is not an instance of the runner's own `DriverError` class. The
 * agent-device driver produces this after every mutation, and the runner's
 * staleness retries must recognize it structurally or a recoverable race
 * becomes an immediate test failure.
 */
function foreignStale(retryable: boolean): Error {
  const error = new Error('stale');
  error.name = 'DriverError';
  Object.assign(error, { code: 'NODE_STALE', retryable });
  return error;
}

function makeEngine(
  script: ScreenScript,
  options: {
    actionTimeout?: number;
    testTimeout?: number;
    onResolveBudget?: (timeoutMs: number) => void;
  } = {},
) {
  const calls = { resolve: 0, read: 0, perform: 0 };
  const next = <T>(steps: T[] | undefined, kind: keyof typeof calls): T | undefined => {
    const step = steps?.[calls[kind]];
    calls[kind] += 1;
    return step;
  };
  const session = {
    screen: {
      async resolve(_expression: LocatorExpression, operation: { timeoutMs: number }) {
        options.onResolveBudget?.(operation.timeoutMs);
        const step = next(script.resolve, 'resolve');
        if (step === undefined || typeof step === 'function') return step?.() ?? [REF];
        if (step === 'stale') throw new DriverError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'frame')
          throw new DriverError('FRAME_NOT_FOUND', 'frame missing', { retryable: true });
        throw new DriverError('DRIVER_FAILURE', 'backend died', { retryable: false });
      },
      async read() {
        const step = next(script.read, 'read');
        if (step === undefined || typeof step === 'function') return step?.() ?? NODE;
        if (step === 'stale') throw new DriverError('NODE_STALE', 'stale', { retryable: false });
        if (step === 'foreign-stale') throw foreignStale(false);
        throw new DriverError('DRIVER_FAILURE', 'backend died', { retryable: false });
      },
      async perform() {
        const step = next(script.perform, 'perform');
        if (step === undefined || typeof step === 'function') return step?.();
        if (step === 'stale') throw new DriverError('NODE_STALE', 'stale', { retryable: true });
        if (step === 'foreign-stale') throw foreignStale(true);
        if (step === 'committed')
          throw new DriverError('ACTION_MAY_HAVE_COMMITTED', 'maybe committed', {
            retryable: false,
          });
        throw new DriverError('NOT_ACTIONABLE', 'covered by overlay', { retryable: false });
      },
      async swipe() {},
    },
  } as unknown as DriverSession;
  const engine = new LocatorEngine({
    session,
    signal: new AbortController().signal,
    runId: 'run-1',
    attemptId: 'attempt-1',
    actionTimeout: options.actionTimeout ?? 1_000,
    assertionTimeout: 1_000,
    testDeadline: new Deadline(options.testTimeout ?? 30_000),
    requireOpen: () => {},
  });
  return { engine, calls };
}

describe('LocatorEngine operation budget', () => {
  it('gives an immediate read a real budget instead of an expired one', async () => {
    // The direct-read surfaces express "do not wait for a value" as an expired
    // deadline. That must not become a zero-time budget for the driver: one
    // immediate resolve still costs whatever the backend costs, which a device
    // backend makes obvious where an in-process browser query does not.
    const budgets: number[] = [];
    const { engine } = makeEngine(
      { resolve: [() => [REF]] },
      { actionTimeout: 30_000, onResolveBudget: (ms) => budgets.push(ms) },
    );
    await engine.tryRead(EXPRESSION, new Deadline(0));
    expect(budgets[0]).toBeGreaterThan(1);
    expect(budgets[0]).toBeLessThanOrEqual(30_000);
  });

  it('caps that budget by the remaining test timeout', async () => {
    const budgets: number[] = [];
    const { engine } = makeEngine(
      { resolve: [() => [REF]] },
      { actionTimeout: 30_000, testTimeout: 500, onResolveBudget: (ms) => budgets.push(ms) },
    );
    await engine.tryRead(EXPRESSION, new Deadline(0));
    expect(budgets[0]).toBeLessThanOrEqual(500);
  });
});

describe('LocatorEngine resolve retry contract', () => {
  it('retries retryable frame misses until the driver recovers', async () => {
    const { engine, calls } = makeEngine({ resolve: ['frame', 'stale', () => [REF]] });
    const refs = await engine.resolveAll(EXPRESSION);
    expect(refs).toEqual([REF]);
    expect(calls.resolve).toBe(3);
  });

  it('translates a non-retryable resolve failure immediately without retrying', async () => {
    const { engine, calls } = makeEngine({ resolve: ['failure'] });
    await expect(engine.resolveAll(EXPRESSION)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'DRIVER_FAILURE',
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

  it('enforces the requireOpen gate before touching the driver', async () => {
    const calls = { resolve: 0 };
    const session = {
      screen: {
        async resolve() {
          calls.resolve += 1;
          return [REF];
        },
      },
    } as unknown as DriverSession;
    const engine = new LocatorEngine({
      session,
      signal: new AbortController().signal,
      runId: 'run-1',
      attemptId: 'attempt-1',
      actionTimeout: 1_000,
      assertionTimeout: 1_000,
      testDeadline: new Deadline(30_000),
      requireOpen: () => {
        throw new E2EError('test', 'APP_NOT_OPEN', 'call app.open() first');
      },
    });
    await expect(engine.resolveAll(EXPRESSION)).rejects.toMatchObject({ code: 'APP_NOT_OPEN' });
    expect(calls.resolve).toBe(0);
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
      code: 'DRIVER_FAILURE',
      category: 'infrastructure',
    });
  });

  it('direct read surfaces stale nodes as LOCATOR_NOT_FOUND', async () => {
    const { engine } = makeEngine({ read: ['stale'] });
    await expect(engine.read(EXPRESSION)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });
});

describe('translateDriverError mapping table', () => {
  const cases: Array<[DriverErrorCode, string, string]> = [
    ['NODE_STALE', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_NOT_FOUND', 'test', 'LOCATOR_NOT_FOUND'],
    ['FRAME_AMBIGUOUS', 'test', 'LOCATOR_AMBIGUOUS'],
    ['NOT_ACTIONABLE', 'test', 'ACTION_FAILED'],
    ['ACTION_MAY_HAVE_COMMITTED', 'test', 'ACTION_FAILED'],
    ['OPERATION_TIMEOUT', 'test', 'ACTION_FAILED'],
    ['CANCELLED', 'infrastructure', 'CANCELLED'],
    ['UNSUPPORTED_CAPABILITY', 'configuration', 'UNSUPPORTED_CAPABILITY'],
    ['INVALID_STATE', 'test', 'APP_NOT_OPEN'],
    ['DRIVER_FAILURE', 'infrastructure', 'DRIVER_FAILURE'],
  ];

  it.each(cases)('%s -> %s/%s', (driverCode, category, code) => {
    const translated = translateDriverError(
      new DriverError(driverCode, 'boom', { retryable: false }),
    );
    expect(translated).toBeInstanceOf(E2EError);
    expect(translated.category).toBe(category);
    expect(translated.code).toBe(code);
    expect(translated.cause).toBeInstanceOf(DriverError);
  });

  it('passes existing E2EErrors through unchanged', () => {
    const original = new E2EError('configuration', 'INVALID_CONFIG', 'bad config');
    expect(translateDriverError(original)).toBe(original);
  });

  it('wraps unknown errors as infrastructure DRIVER_FAILURE', () => {
    const translated = translateDriverError(new Error('socket hangup'));
    expect(translated.category).toBe('infrastructure');
    expect(translated.code).toBe('DRIVER_FAILURE');
    expect(translated.message).toContain('socket hangup');
    expect(translateDriverError('string failure').message).toContain('string failure');
  });

  it('appends the locator description when an expression is provided', () => {
    const translated = translateDriverError(
      new DriverError('NODE_STALE', 'stale', { retryable: false }),
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
