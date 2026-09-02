import { describe, expect, it } from 'vitest';
import {
  classifyError,
  combineExitCodes,
  ConfigurationError,
  E2EError,
  exitCodeForCategory,
  InfrastructureError,
  sanitizeText,
  serializeError,
  TestError,
  truncateUtf8,
} from '../../src/internal/errors.ts';
import { BackendError } from '../../src/backend/surface.ts';

describe('exit code mapping', () => {
  it('maps categories per 06-cli.md', () => {
    expect(exitCodeForCategory('test')).toBe(1);
    expect(exitCodeForCategory('configuration')).toBe(2);
    expect(exitCodeForCategory('infrastructure')).toBe(3);
    expect(exitCodeForCategory('internal')).toBe(4);
    expect(exitCodeForCategory('interrupted')).toBe(130);
  });

  it('combines with precedence 130 > 4 > 3 > 2 > 1 > 0', () => {
    expect(combineExitCodes([0, 1, 2])).toBe(2);
    expect(combineExitCodes([1, 3])).toBe(3);
    expect(combineExitCodes([4, 3, 130])).toBe(130);
    expect(combineExitCodes([0])).toBe(0);
    expect(combineExitCodes([])).toBe(0);
  });
});

describe('classifyError', () => {
  it('passes through E2EError instances', () => {
    const error = new InfrastructureError('X', 'boom');
    expect(classifyError(error)).toBe(error);
  });

  it('wraps unknown errors as test failures', () => {
    expect(classifyError(new Error('nope')).category).toBe('test');
    expect(classifyError('string failure').category).toBe('test');
  });

  it('applies the canonical driver mapping to BackendErrors from any surface', () => {
    const failure = classifyError(
      new BackendError('BACKEND_FAILURE', 'backend died', { retryable: false }),
    );
    expect(failure.category).toBe('infrastructure');
    expect(failure.code).toBe('BACKEND_FAILURE');

    const unsupported = classifyError(
      new BackendError('UNSUPPORTED_CAPABILITY', 'no video', { retryable: false }),
    );
    expect(unsupported.category).toBe('configuration');
    expect(unsupported.code).toBe('UNSUPPORTED_CAPABILITY');

    const cancelled = classifyError(new BackendError('CANCELLED', 'stop', { retryable: false }));
    expect(cancelled.category).toBe('infrastructure');
    expect(cancelled.code).toBe('CANCELLED');

    const invalidState = classifyError(
      new BackendError('INVALID_STATE', 'nothing open', { retryable: false }),
    );
    expect(invalidState.category).toBe('test');
    expect(invalidState.code).toBe('APP_NOT_OPEN');
  });
});

describe('serializeError', () => {
  it('produces the bounded report shape', () => {
    const serialized = serializeError(new TestError('ASSERTION_FAILED', 'expected x'), {
      phase: 'body',
    });
    expect(serialized).toMatchObject({
      category: 'test',
      code: 'ASSERTION_FAILED',
      message: 'expected x',
      retryable: false,
      phase: 'body',
    });
  });

  it('strips control characters from messages', () => {
    const serialized = serializeError(new ConfigurationError('X', 'a\u0007b\u001bc'));
    expect(serialized.message).toBe('a\uFFFDb\uFFFDc');
  });
});

describe('sanitizeText', () => {
  it('keeps tabs and newlines', () => {
    expect(sanitizeText('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('truncateUtf8', () => {
  it('truncates on code point boundaries', () => {
    expect(truncateUtf8('abcd', 2)).toBe('ab');
    expect(truncateUtf8('żż', 3)).toBe('ż'); // 2 bytes each
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });
});

describe('E2EError', () => {
  it('carries category, code, and retryability', () => {
    const error = new E2EError('infrastructure', 'BACKEND_FAILURE', 'x', { retryable: false });
    expect(error.category).toBe('infrastructure');
    expect(error.code).toBe('BACKEND_FAILURE');
    expect(error.retryable).toBe(false);
  });
});
