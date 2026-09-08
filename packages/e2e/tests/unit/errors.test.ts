import { describe, expect, it } from 'vitest';
import {
  classifyError,
  combineExitCodes,
  ConfigurationError,
  E2EError,
  exitCodeForCategory,
  InfrastructureError,
  messageWithCauses,
  sanitizeText,
  withHint,
  serializeError,
  TestError,
  translateProvisioningError,
  truncateUtf8,
} from '../../src/internal/errors.ts';
import { EngineError } from '../../src/engine/surface.ts';

describe('translateProvisioningError', () => {
  it('never yields a test error: an engine error of any code is infrastructure', () => {
    const stale = translateProvisioningError(
      new EngineError('NODE_STALE', 'ref gone', { retryable: true }),
      ' while preparing',
    );
    expect(stale.category).toBe('infrastructure');
    expect(stale.code).toBe('ENGINE_FAILURE');
    expect(stale.message).toBe('ref gone while preparing');
    const plain = translateProvisioningError(new Error('download failed'), ' while preparing');
    expect(plain.category).toBe('infrastructure');
    expect(plain.message).toBe('download failed while preparing');
  });

  it('keeps a cancellation a cancellation', () => {
    const cancelled = translateProvisioningError(
      new EngineError('CANCELLED', 'browser install cancelled', { retryable: false }),
    );
    expect(cancelled.category).toBe('infrastructure');
    expect(cancelled.code).toBe('CANCELLED');
  });

  it('keeps the category of a harness-classified error', () => {
    const config = translateProvisioningError(new ConfigurationError('INVALID_CONFIG', 'no such browser'));
    expect(config.category).toBe('configuration');
    const infra = translateProvisioningError(new InfrastructureError('BROWSER_INSTALL_FAILED', 'exit 1'));
    expect(infra.code).toBe('BROWSER_INSTALL_FAILED');
  });
});

describe('exit code mapping', () => {
  it('maps categories', () => {
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

  it('appends the cause chain to a plain error, the way fetch reports a refused connection', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' });
    expect(classifyError(new TypeError('fetch failed', { cause: refused })).message).toBe(
      'fetch failed: connect ECONNREFUSED 127.0.0.1:3000',
    );
    // Node reports a dual-stack failure as an aggregate whose members carry the detail.
    const aggregate = new AggregateError(
      [Object.assign(new Error(''), { code: 'ECONNREFUSED' }), new Error('connect ECONNREFUSED ::1:3000')],
      '',
    );
    expect(classifyError(new TypeError('fetch failed', { cause: aggregate })).message).toBe(
      'fetch failed: ECONNREFUSED; connect ECONNREFUSED ::1:3000',
    );
    expect(messageWithCauses(new Error('same', { cause: new Error('same') }))).toBe('same');
    expect(messageWithCauses(new Error('outer', { cause: 'text' }))).toBe('outer: text');
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new Error('d', { cause: new Error('e') }) }) }) });
    expect(messageWithCauses(deep)).toBe('a: b: c: d');
  });

  it('applies the canonical driver mapping to EngineErrors from any surface', () => {
    const failure = classifyError(
      new EngineError('ENGINE_FAILURE', 'engine died', { retryable: false }),
    );
    expect(failure.category).toBe('infrastructure');
    expect(failure.code).toBe('ENGINE_FAILURE');

    const unsupported = classifyError(
      new EngineError('UNSUPPORTED_CAPABILITY', 'no video', { retryable: false }),
    );
    expect(unsupported.category).toBe('configuration');
    expect(unsupported.code).toBe('UNSUPPORTED_CAPABILITY');

    const cancelled = classifyError(new EngineError('CANCELLED', 'stop', { retryable: false }));
    expect(cancelled.category).toBe('infrastructure');
    expect(cancelled.code).toBe('CANCELLED');

    const invalidState = classifyError(
      new EngineError('INVALID_STATE', 'nothing open', { retryable: false }),
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

  it('strips control characters and ANSI colors from messages', () => {
    const serialized = serializeError(new ConfigurationError('X', 'a\u0007b\u0001c'));
    expect(serialized.message).toBe('a\uFFFDb\uFFFDc');
    const colored = serializeError(new ConfigurationError('X', '\u001b[1m\u001b[31mUnauthenticated\u001b[0m request'));
    expect(colored.message).toBe('Unauthenticated request');
  });
});

describe('sanitizeText', () => {
  it('keeps tabs and newlines', () => {
    expect(sanitizeText('a\tb\nc')).toBe('a\tb\nc');
  });

  it('replaces C0, DEL, and C1 controls and leaves non-BMP text intact', () => {
    expect(sanitizeText('a\u0000b\u007fc\u0085d')).toBe('a\uFFFDb\uFFFDc\uFFFDd');
    expect(sanitizeText('ok 😀 fine')).toBe('ok 😀 fine');
  });

  it('is repeatable across calls (no regexp state leaks)', () => {
    expect(sanitizeText('\u0001\u0001')).toBe('\uFFFD\uFFFD');
    expect(sanitizeText('\u0001x')).toBe('\uFFFDx');
  });
});

describe('withHint', () => {
  it('joins a clause to one line and starts a new line after a paragraph', () => {
    expect(withHint('nope', 'try this')).toBe('nope; try this');
    expect(withHint('first line\nsecond line\n\n', 'try this')).toBe('first line\nsecond line\ntry this');
    expect(withHint('nope', '')).toBe('nope');
  });
});

describe('truncateUtf8', () => {
  it('truncates on code point boundaries', () => {
    expect(truncateUtf8('abcd', 2)).toBe('ab');
    expect(truncateUtf8('żż', 3)).toBe('ż'); // 2 bytes each
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });

  it('never splits a four-byte code point and honors a zero budget', () => {
    expect(truncateUtf8('a😀b', 4)).toBe('a'); // 😀 is 4 bytes; 1 + 4 > 4
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('a😀b', 0)).toBe('');
  });
});

describe('E2EError', () => {
  it('carries category, code, and retryability', () => {
    const error = new E2EError('infrastructure', 'ENGINE_FAILURE', 'x', { retryable: false });
    expect(error.category).toBe('infrastructure');
    expect(error.code).toBe('ENGINE_FAILURE');
    expect(error.retryable).toBe(false);
  });
});
