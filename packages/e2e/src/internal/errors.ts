/** Runner-owned error taxonomy and exit-code mapping (spec 06-cli.md). */

import { DriverError } from '../driver/index.ts';

export type ErrorCategory =
  | 'test'
  | 'configuration'
  | 'infrastructure'
  | 'internal'
  | 'interrupted';

export type ErrorPhase =
  | 'config'
  | 'collection'
  | 'launch'
  | 'beforeAll'
  | 'beforeEach'
  | 'body'
  | 'afterEach'
  | 'afterAll'
  | 'cleanup'
  | 'report';

export interface SerializedError {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  phase?: ErrorPhase;
  scopeId?: string;
  stack?: string;
}

/** Marks classified errors so instances survive isolated module realms. */
const E2E_ERROR_MARKER = Symbol.for('e2e.error.v1');

/** Base class for every runner-classified error. */
export class E2EError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly [E2E_ERROR_MARKER] = true;

  constructor(
    category: ErrorCategory,
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'E2EError';
    this.category = category;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'test',
  'configuration',
  'infrastructure',
  'internal',
  'interrupted',
]);

/** Detects an E2EError created by another copy of this module. */
function isForeignE2EError(value: unknown): value is Error & {
  category: ErrorCategory;
  code: string;
  retryable: boolean;
} {
  return (
    value instanceof Error &&
    (value as unknown as Record<PropertyKey, unknown>)[E2E_ERROR_MARKER] === true &&
    CATEGORIES.has((value as { category?: ErrorCategory }).category as ErrorCategory) &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export class ConfigurationError extends E2EError {
  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super('configuration', code, message, options);
    this.name = 'ConfigurationError';
  }
}

export class CollectionError extends ConfigurationError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('COLLECTION_ERROR', message, options);
    this.name = 'CollectionError';
  }
}

export class InfrastructureError extends E2EError {
  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super('infrastructure', code, message, options);
    this.name = 'InfrastructureError';
  }
}

export class InternalError extends E2EError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('internal', 'INTERNAL_ERROR', message, options);
    this.name = 'InternalError';
  }
}

export class TestError extends E2EError {
  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super('test', code, message, options);
    this.name = 'TestError';
  }
}

export class TestTimeoutError extends TestError {
  constructor(message: string) {
    super('TEST_TIMEOUT', message);
    this.name = 'TestTimeoutError';
  }
}

export class InterruptedError extends E2EError {
  constructor(message = 'Run interrupted') {
    super('interrupted', 'INTERRUPTED', message);
    this.name = 'InterruptedError';
  }
}

/** Maps a category to its process exit code per 06-cli.md. */
export function exitCodeForCategory(category: ErrorCategory): 0 | 1 | 2 | 3 | 4 | 130 {
  switch (category) {
    case 'test':
      return 1;
    case 'configuration':
      return 2;
    case 'infrastructure':
      return 3;
    case 'internal':
      return 4;
    case 'interrupted':
      return 130;
  }
}

/** Combines exit codes for mixed outcomes using precedence 130 > 4 > 3 > 2 > 1 > 0. */
export function combineExitCodes(codes: readonly number[]): 0 | 1 | 2 | 3 | 4 | 130 {
  const precedence: readonly (0 | 1 | 2 | 3 | 4 | 130)[] = [130, 4, 3, 2, 1, 0];
  for (const candidate of precedence) {
    if (codes.includes(candidate)) return candidate;
  }
  return 0;
}

/**
 * Canonical DriverError -> runner taxonomy mapping (spec 09-drivers.md).
 * Applies to every driver surface: launch, app, screen, web, artifacts,
 * state capture/restore, and close. Non-DriverError causes become
 * non-retryable infrastructure DRIVER_FAILURE.
 */
export function translateDriverError(cause: unknown, suffix = ''): E2EError {
  if (cause instanceof E2EError) return cause;
  if (cause instanceof DriverError) {
    switch (cause.code) {
      case 'NODE_STALE':
        return new TestError('LOCATOR_NOT_FOUND', `node became stale${suffix}`, { cause });
      case 'FRAME_NOT_FOUND':
        return new TestError('LOCATOR_NOT_FOUND', `${cause.message}${suffix}`, { cause });
      case 'FRAME_AMBIGUOUS':
        return new TestError('LOCATOR_AMBIGUOUS', `${cause.message}${suffix}`, { cause });
      case 'NOT_ACTIONABLE':
        return new TestError('ACTION_FAILED', `${cause.message}${suffix}`, { cause });
      case 'ACTION_MAY_HAVE_COMMITTED':
        return new TestError('ACTION_FAILED', `${cause.message}${suffix}`, { cause });
      case 'OPERATION_TIMEOUT':
        return new TestError('ACTION_FAILED', `operation timed out${suffix}`, { cause });
      case 'CANCELLED':
        return new E2EError('infrastructure', 'CANCELLED', 'operation cancelled', { cause });
      case 'UNSUPPORTED_CAPABILITY':
        return new E2EError('configuration', 'UNSUPPORTED_CAPABILITY', cause.message, { cause });
      case 'INVALID_STATE':
        return new TestError('APP_NOT_OPEN', cause.message, { cause });
      case 'DRIVER_FAILURE':
        return new E2EError('infrastructure', 'DRIVER_FAILURE', cause.message, { cause });
    }
  }
  return new E2EError(
    'infrastructure',
    'DRIVER_FAILURE',
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
}

/** Classifies an arbitrary thrown value into an E2EError; unknown values become test failures. */
export function classifyError(value: unknown): E2EError {
  if (value instanceof E2EError) return value;
  if (isForeignE2EError(value)) {
    return new E2EError(value.category, value.code, value.message, {
      retryable: value.retryable,
      cause: value,
    });
  }
  if (value instanceof DriverError) {
    return translateDriverError(value);
  }
  if (value instanceof Error) {
    return new TestError('ERROR', value.message, { cause: value });
  }
  return new TestError('ERROR', String(value));
}

const MAX_MESSAGE_BYTES = 8192;

/** Serializes an error into the bounded report-1 error shape. */
export function serializeError(
  error: E2EError,
  extras: { phase?: ErrorPhase; scopeId?: string } = {},
): SerializedError {
  const serialized: SerializedError = {
    category: error.category,
    code: error.code,
    message: truncateUtf8(sanitizeText(error.message), MAX_MESSAGE_BYTES),
    retryable: error.retryable,
  };
  if (extras.phase !== undefined) serialized.phase = extras.phase;
  if (extras.scopeId !== undefined) serialized.scopeId = extras.scopeId;
  const stack = (error.cause instanceof Error ? error.cause.stack : undefined) ?? error.stack;
  if (stack !== undefined) serialized.stack = truncateUtf8(sanitizeText(stack), 65536);
  return serialized;
}

/** Strips C0/C1 control characters except tab and newline. */
export function sanitizeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    out += isControl ? '\uFFFD' : ch;
  }
  return out;
}

/** Truncates a string so its UTF-8 encoding fits maxBytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).byteLength;
    if (bytes + chBytes > maxBytes) break;
    result += ch;
    bytes += chBytes;
  }
  return result;
}
