import { describe, expect, it } from 'vitest';
import { createCleanupQueue } from '../../src/run/cleanup.ts';

describe('cleanup queue', () => {
  it('hands callbacks back newest first, including ones added while draining', () => {
    const queue = createCleanupQueue();
    const first = () => undefined;
    const second = () => undefined;
    const third = () => undefined;
    queue.fixture.add(first);
    queue.fixture.add(second);
    expect(queue.take()).toBe(second);
    queue.fixture.add(third);
    expect(queue.take()).toBe(third);
    expect(queue.take()).toBe(first);
    expect(queue.take()).toBeUndefined();
  });

  it('refuses a registration once sealed and a value that is not a function', () => {
    const queue = createCleanupQueue();
    expect(() => queue.fixture.add('later' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    queue.seal();
    expect(() => queue.fixture.add(() => undefined)).toThrow(
      expect.objectContaining({ code: 'TEST_SETUP_FAILED', message: expect.stringContaining('after the test') }),
    );
    expect(queue.take()).toBeUndefined();
  });
});
