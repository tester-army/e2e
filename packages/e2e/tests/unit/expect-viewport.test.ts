import { describe, expect, it } from 'vitest';
import { EngineError, resolveExpression, type SemanticNode } from '../../src/engine/index.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const viewport = { width: 1280, height: 720 };

function target(rect?: { x: number; y: number; width: number; height: number }): SemanticNode {
  return {
    ref: { id: 'target', revision: '' },
    role: 'generic',
    testId: 'target',
    ...(rect === undefined ? {} : { rect }),
  };
}

function screenWith(rect?: { x: number; y: number; width: number; height: number }) {
  return createScreenFixture([target(rect)]);
}

describe('toBeInViewport', () => {
  it('uses any positive intersection by default and a ratio when supplied', async () => {
    const screen = screenWith({ x: -90, y: 10, width: 100, height: 50 });
    const locator = screen.getByTestId('target');

    await expectFixture(locator).toBeInViewport();
    await expectFixture(locator).toBeInViewport({ ratio: 0 });
    await expectFixture(locator).toBeInViewport({ ratio: 0.1 });
    await expect(expectFixture(locator).toBeInViewport({ ratio: 0.11, timeout: 50 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
    });
  });

  it('treats offscreen and zero-size boxes as out of the viewport', async () => {
    await expectFixture(screenWith({ x: 1300, y: 10, width: 20, height: 20 }).getByTestId('target')).not.toBeInViewport({
      ratio: 0,
      timeout: 30,
    });
    await expectFixture(screenWith({ x: 20, y: 20, width: 0, height: 20 }).getByTestId('target')).not.toBeInViewport({
      timeout: 30,
    });
  });

  it('fails clearly when the box is missing, including under .not', async () => {
    const locator = screenWith().getByTestId('target');

    await expect(expectFixture(locator).toBeInViewport({ timeout: 30 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: no bounding box'),
    });
    await expect(expectFixture(locator).not.toBeInViewport({ timeout: 30 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: no bounding box'),
    });
  });

  it('rejects invalid ratios and unknown options before reading', () => {
    const locator = expectFixture(screenWith({ x: 0, y: 0, width: 10, height: 10 }).getByTestId('target'));

    expect(() => locator.toBeInViewport({ ratio: -0.1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => locator.toBeInViewport({ ratio: 1.1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => locator.toBeInViewport({ ratio: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => locator.toBeInViewport({ ratio: 0.5, threshold: 0.5 } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('polls until the box enters the viewport', async () => {
    const state = { rect: { x: 1300, y: 10, width: 20, height: 20 } };
    const currentTarget = (): SemanticNode => target(state.rect);
    const screen = screenOver({
      locate: (expression) => resolveExpression(expression, [currentTarget()]),
      observe: () => ({ ...snapshot([currentTarget()]), viewport }),
      timeoutMs: 300,
    }).screen;

    setTimeout(() => {
      state.rect = { x: 20, y: 20, width: 20, height: 20 };
    }, 25);

    await expectFixture(screen.getByTestId('target')).toBeInViewport({ timeout: 200 });
  });

  it('retries when navigation makes the viewport observation stale', async () => {
    let observations = 0;
    const node = target({ x: 20, y: 20, width: 20, height: 20 });
    const screen = screenOver({
      locate: (expression) => resolveExpression(expression, [node]),
      observe: () => {
        observations += 1;
        if (observations === 1) throw new EngineError('NODE_STALE', 'navigation changed', { retryable: true });
        return { ...snapshot([node]), viewport };
      },
      timeoutMs: 300,
    }).screen;

    await expectFixture(screen.getByTestId('target')).toBeInViewport({ timeout: 200 });
    expect(observations).toBeGreaterThan(1);
  });
});
